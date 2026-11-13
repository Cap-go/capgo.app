import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSupabaseWorktreeConfig } from './supabase-worktree-config'

/**
 * Local Postgres without the Supabase stack: the database only.
 *
 *   bun run db:up         start this worktree's Postgres container
 *   bun run db:provision  bootstrap, apply pending migrations, seed a fresh database
 *   bun run db:url        print the connection URL
 *   bun run db:down       stop the container and delete its data
 *
 * `supabase start` is unchanged and runs its own database; this is a separate path for
 * work that only needs Postgres (SQL tests, checking that migrations apply).
 * No Supabase CLI: psql runs inside the container.
 */

// Not used by supabase/config.toml. Worktree offsets are multiples of 10, so it never
// lands on another worktree's Supabase ports either.
const BASE_PORT = 54328
const SUPABASE_DB_BASE_PORT = 54322
const MIGRATION_FILE = /^(\d+)_(\w+)\.sql$/
const SEED_PATH = 'supabase/seed.sql'
const APPLYING = 'Applying'

export interface LocalDbConfig {
  repoRoot: string
  project: string
  port: number
}

export interface MigrationFile {
  file: string
  version: string
  name: string
}

export function getLocalDbConfig(cwd: string = process.cwd()): LocalDbConfig {
  const cfg = getSupabaseWorktreeConfig(cwd)
  const offset = cfg.ports.db - SUPABASE_DB_BASE_PORT
  return { repoRoot: cfg.repoRoot, project: `capgo-db-${cfg.worktreeHash}`, port: BASE_PORT + offset }
}

export function localDbUrl(cfg: LocalDbConfig): string {
  return `postgresql://postgres:postgres@127.0.0.1:${cfg.port}/postgres`
}

/** Migration files in apply order. Names are validated because they are written into SQL. */
export function parseMigrationFiles(fileNames: readonly string[]): MigrationFile[] {
  return fileNames
    .filter(file => file.endsWith('.sql'))
    .map((file) => {
      const match = MIGRATION_FILE.exec(file)
      if (!match)
        throw new Error(`Unexpected migration file name: ${file} (expected <timestamp>_<name>.sql)`)
      return { file, version: match[1], name: match[2] }
    })
    .sort((a, b) => a.version.localeCompare(b.version))
}

export function pendingMigrations(all: readonly MigrationFile[], applied: ReadonlySet<string>): MigrationFile[] {
  return all.filter(migration => !applied.has(migration.version))
}

export interface MigrationToApply extends MigrationFile {
  sql: string
}

/**
 * One psql script for all pending migrations, so they share a single `docker compose exec`.
 * Each migration commits together with its history row; the echo names the file if it fails.
 * DISCARD ALL gives the next migration a clean session (some migrations `SET statement_timeout`).
 */
export function migrationsScript(migrations: readonly MigrationToApply[]): string {
  return migrations.map(migration => [
    `\\echo '${APPLYING} ${migration.file}'`,
    'BEGIN;',
    migration.sql,
    ';',
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${migration.version}', '${migration.name}');`,
    'COMMIT;',
    'DISCARD ALL;',
    '',
  ].join('\n')).join('\n')
}

/** The seed followed by its history row. seed.sql is not re-runnable, so it runs once per database. */
export function seedWithHistory(sql: string): string {
  const hash = createHash('sha256').update(sql).digest('hex')
  return `${sql}\n;\nINSERT INTO supabase_migrations.seed_files (path, hash) VALUES ('${SEED_PATH}', '${hash}');\n`
}

// Same tables the Supabase CLI keeps, so its tooling reads this history too. Prints one
// `migration:<version>` line per applied migration and `seed:<path>` per applied seed.
const HISTORY_SQL = `
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL);
SELECT 'migration:' || version FROM supabase_migrations.schema_migrations
UNION ALL
SELECT 'seed:' || path FROM supabase_migrations.seed_files;
`

export interface History {
  applied: Set<string>
  seeded: boolean
}

export function parseHistory(output: string): History {
  const lines = output.split('\n').map(line => line.trim())
  return {
    applied: new Set(lines.filter(line => line.startsWith('migration:')).map(line => line.slice('migration:'.length))),
    seeded: lines.includes(`seed:${SEED_PATH}`),
  }
}

/** `docker compose` for this worktree's project. `inherit` streams output to the terminal. */
function compose(cfg: LocalDbConfig, args: string[], options: { input?: string, inherit?: boolean } = {}) {
  return spawnSync('docker', ['compose', '-p', cfg.project, '-f', resolve(cfg.repoRoot, 'supabase/local-db.compose.yml'), ...args], {
    cwd: cfg.repoRoot,
    env: { ...process.env, CAPGO_LOCAL_DB_PORT: String(cfg.port) },
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
}

type DbUser = 'postgres' | 'supabase_admin'

/**
 * Run SQL from stdin inside the container (no host psql, no TLS) and return stdout.
 * `psqlArgs` adds flags such as `--single-transaction` or `-A -t`.
 */
function psql(cfg: LocalDbConfig, user: DbUser, sql: string, label: string, psqlArgs: string[]): string {
  const res = compose(cfg, ['exec', '-T', 'db', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', user, '-d', 'postgres', ...psqlArgs, '-f', '-'], { input: sql })
  if (res.error)
    throw new Error(`${label}: could not run docker compose: ${res.error.message}`)
  if (res.status !== 0) {
    const failing = (res.stdout || '').split('\n').filter(line => line.startsWith(`${APPLYING} `)).pop()
    const errors = (res.stderr || '').split('\n').filter(line => /ERROR|FATAL|DETAIL|HINT|CONTEXT|LINE \d/.test(line))
    throw new Error(`${failing ?? label} failed:\n${(errors.length ? errors : [res.stderr || '']).slice(0, 15).join('\n')}`)
  }
  return res.stdout || ''
}

function isRunning(cfg: LocalDbConfig): boolean {
  const res = compose(cfg, ['ps', '--status', 'running', '-q', 'db'])
  return res.status === 0 && (res.stdout || '').trim().length > 0
}

function up(cfg: LocalDbConfig): number {
  const res = compose(cfg, ['up', '-d', '--wait'], { inherit: true })
  if (res.status !== 0)
    return res.status ?? 1
  console.log(`Local Postgres is up: ${localDbUrl(cfg)}\nNext: bun run db:provision`)
  return 0
}

function down(cfg: LocalDbConfig): number {
  return compose(cfg, ['down', '-v', '--remove-orphans'], { inherit: true }).status ?? 1
}

function provision(cfg: LocalDbConfig): number {
  if (!isRunning(cfg)) {
    console.error('Local Postgres is not running. Start it with `bun run db:up`.')
    return 1
  }
  const supabaseDir = resolve(cfg.repoRoot, 'supabase')

  psql(cfg, 'supabase_admin', readFileSync(resolve(supabaseDir, 'bootstrap.sql'), 'utf8'), 'bootstrap.sql', ['--single-transaction'])
  const history = parseHistory(psql(cfg, 'postgres', HISTORY_SQL, 'migration history', ['--single-transaction', '-A', '-t']))

  const migrations = parseMigrationFiles(readdirSync(resolve(supabaseDir, 'migrations')))
  const pending = pendingMigrations(migrations, history.applied).map(migration => ({
    ...migration,
    sql: readFileSync(resolve(supabaseDir, 'migrations', migration.file), 'utf8'),
  }))
  if (pending.length > 0)
    psql(cfg, 'postgres', migrationsScript(pending), 'migrations', [])
  console.log(`Migrations: ${pending.length} applied, ${migrations.length - pending.length} already there.`)

  if (history.seeded) {
    console.log('Seed: already applied (`bun run db:down && bun run db:up` for a fresh database).')
  }
  else {
    psql(cfg, 'postgres', seedWithHistory(readFileSync(resolve(cfg.repoRoot, SEED_PATH), 'utf8')), 'seed.sql', ['--single-transaction'])
    console.log('Seed: applied.')
  }
  console.log(`Ready: ${localDbUrl(cfg)}`)
  return 0
}

const USAGE = 'Usage: bun scripts/local-db.ts <up|provision|url|down>'

function main(): number {
  try {
    const cfg = getLocalDbConfig()
    switch (process.argv[2]) {
      case 'up':
        return up(cfg)
      case 'provision':
        return provision(cfg)
      case 'url':
        console.log(localDbUrl(cfg))
        return 0
      case 'down':
        return down(cfg)
      default:
        console.error(USAGE)
        return 2
    }
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main)
  process.exit(main())
