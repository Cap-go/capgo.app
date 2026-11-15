import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLocalDbConfig, migrationsScript, parseHistory, parseMigrationFiles, pendingMigrations, seedWithHistory, summarizeTap } from '../scripts/local-db'
import { getSupabaseWorktreeConfig } from '../scripts/supabase-worktree-config'

describe('parseMigrationFiles', () => {
  it('orders migrations by version and ignores non-SQL files', () => {
    const parsed = parseMigrationFiles(['20260801000000_b.sql', 'README.md', '20260708000000_a.sql'])
    expect(parsed).toEqual([
      { file: '20260708000000_a.sql', version: '20260708000000', name: 'a' },
      { file: '20260801000000_b.sql', version: '20260801000000', name: 'b' },
    ])
  })

  it('rejects names that are not <timestamp>_<name>.sql', () => {
    expect(() => parseMigrationFiles(['20260708000000_bad\'name.sql'])).toThrow('Unexpected migration file name')
    expect(() => parseMigrationFiles(['nodate.sql'])).toThrow('Unexpected migration file name')
  })

  it('accepts every migration in the repository', () => {
    const files = readdirSync(resolve(__dirname, '../supabase/migrations'))
    expect(parseMigrationFiles(files)).toHaveLength(files.filter(file => file.endsWith('.sql')).length)
  })
})

describe('pendingMigrations', () => {
  it('keeps only versions missing from the history table', () => {
    const all = parseMigrationFiles(['1_a.sql', '2_b.sql', '3_c.sql'])
    expect(pendingMigrations(all, new Set(['1', '3'])).map(m => m.version)).toEqual(['2'])
  })
})

describe('migrationsScript', () => {
  it('wraps each migration with its history row in its own transaction, even when the file ends in a comment', () => {
    const script = migrationsScript([
      { file: '1_a.sql', version: '1', name: 'a', sql: 'CREATE TABLE t (id int); -- trailing comment' },
      { file: '2_b.sql', version: '2', name: 'b', sql: 'SELECT 1;' },
    ])
    expect(script).toBe([
      '\\echo \'Applying 1_a.sql\'',
      'BEGIN;',
      'CREATE TABLE t (id int); -- trailing comment',
      ';',
      'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (\'1\', \'a\');',
      'COMMIT;',
      'DISCARD ALL;',
      '',
      '\\echo \'Applying 2_b.sql\'',
      'BEGIN;',
      'SELECT 1;',
      ';',
      'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (\'2\', \'b\');',
      'COMMIT;',
      'DISCARD ALL;',
      '',
    ].join('\n'))
  })
})

describe('parseHistory', () => {
  it('reads applied versions and whether seed.sql ran', () => {
    expect(parseHistory('migration:1\nmigration:2\nseed:supabase/seed.sql\n')).toEqual({ applied: new Set(['1', '2']), seeded: true })
    expect(parseHistory('')).toEqual({ applied: new Set(), seeded: false })
  })
})

describe('seedWithHistory', () => {
  it('records seed.sql with its sha256 so the next provision skips it', () => {
    expect(seedWithHistory('SELECT 1;')).toBe(
      'SELECT 1;\n;\nINSERT INTO supabase_migrations.seed_files (path, hash) VALUES (\'supabase/seed.sql\', \'17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a\');\n',
    )
  })
})

describe('summarizeTap', () => {
  it('passes a file whose plan matches its ok lines', () => {
    expect(summarizeTap('1..2\nok 1 - first\nok 2 - second\n', 0)).toEqual({ ok: 2, notOk: 0, planned: 2, failure: null })
  })

  it('fails on any not ok line', () => {
    expect(summarizeTap('1..2\nok 1 - first\nnot ok 2 - second\n# Failed test 2: "second"\n', 0).failure).toBe('1 not ok')
  })

  it('fails when fewer tests ran than planned', () => {
    expect(summarizeTap('1..3\nok 1 - first\nok 2 - second\n# Looks like you planned 3 tests but ran 2\n', 0).failure).toBe('planned 3, ran 2')
  })

  it('fails when the file has no plan', () => {
    expect(summarizeTap('ok 1 - first\n', 0).failure).toBe('no plan')
  })

  it('fails on a SQL error even when every printed test passed', () => {
    expect(summarizeTap('1..1\nok 1 - first\n', 3).failure).toBe('psql exited with 3 (SQL error)')
  })
})

describe('getLocalDbConfig', () => {
  it('uses its own port band, shifted by the worktree offset', () => {
    const supabase = getSupabaseWorktreeConfig()
    const local = getLocalDbConfig()
    expect(local.port - 54328).toBe(supabase.ports.db - 54322)
    expect(Object.values(supabase.ports)).not.toContain(local.port)
    expect(local.project).toBe(`capgo-db-${supabase.worktreeHash}`)
  })
})
