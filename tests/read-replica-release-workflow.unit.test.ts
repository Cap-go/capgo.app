import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { REPLICA_TABLES } from '../read_replicate/schema_catalog.ts'
import { readReplicaSchemaCatalogFromMigrations } from '../read_replicate/schema_catalog_from_migrations.ts'

const workflowUrl = new URL(
  '../.github/workflows/build_and_deploy.yml',
  import.meta.url,
)
const syncScriptUrl = new URL(
  '../scripts/sync-read-replica-schema.ts',
  import.meta.url,
)
const schemaCatalogFromMigrationsUrl = new URL(
  '../read_replicate/schema_catalog_from_migrations.ts',
  import.meta.url,
)

function githubExpression(value: string): string {
  return '$' + `{{ ${value} }}`
}

async function readReleaseWorkflow(): Promise<string> {
  return readFile(workflowUrl, 'utf8')
}

async function readReplicaSyncScript(): Promise<string> {
  return readFile(syncScriptUrl, 'utf8')
}

async function readSchemaCatalogFromMigrations(): Promise<string> {
  return readFile(schemaCatalogFromMigrationsUrl, 'utf8')
}

describe('production read-replica release gate', () => {
  it.concurrent(
    'rebuilds the catalog locally and imports only a fully preflighted atomic plan before primary migrations',
    async () => {
      const [workflow, syncScript, catalogFromMigrations] = await Promise.all([
        readReleaseWorkflow(),
        readReplicaSyncScript(),
        readSchemaCatalogFromMigrations(),
      ])

      expect(workflow).not.toContain('google-github-actions/auth@v3')
      expect(workflow).toContain(
        githubExpression('secrets.GOOGLE_SERVICE_ACCOUNT'),
      )
      expect(workflow).toContain('GOOGLE_SERVICE_ACCOUNT_BASE64')
      expect(workflow).toContain('base64 --decode')
      expect(workflow).toContain('gcloud auth activate-service-account')
      expect(workflow).not.toContain('vars.GOOGLE_')
      expect(workflow).not.toContain('READ_REPLICATE_GOOGLE_EU1')
      expect(workflow).not.toContain('check-read-replica-hyperdrive-schema')
      expect(workflow).toContain(
        [
          'read_replica_schema:',
          '    needs: changes',
          `    if: ${githubExpression('needs.changes.result == \'success\' && needs.changes.outputs.supabase == \'true\' && !contains(github.ref_name, \'-alpha\')')}`,
        ].join('\n'),
      )
      expect(workflow).toContain(
        'supabase_deploy:\n    needs: [changes, read_replica_schema]',
      )
      expect(syncScript).toContain('planReadReplicaSchemaSync')
      expect(syncScript).toContain('preflightCompatibilityIssues')
      expect(syncScript).toContain('applyReadReplicaSchemaPlan')
      expect(syncScript).toContain('assertCanApplyReadReplicaSchemaPlan')
      expect(syncScript).toContain('assertGoogleReadReplicaSchemaPlan')
      expect(syncScript).toContain('readReplicaSubscriberCompatibilityIssues')
      expect(syncScript).toContain('gcloud')
      expect(syncScript.indexOf('preflightCompatibilityIssues')).toBeLessThan(
        syncScript.indexOf('await applyPlan(plan)'),
      )
      expect(syncScript).toMatch(/['"]sql['"],\s*['"]import['"],\s*['"]sql['"]/)
      expect(syncScript).toMatch(/--user=(?:postgres|\$\{POSTGRES_IMPORT_USER\})/)
      expect(syncScript).toContain('readReplicaSchemaCatalogFromMigrations')
      expect(syncScript).not.toContain('schema_replicate.catalog.json')
      expect(syncScript).toContain('BEGIN;')
      expect(syncScript).toContain('COMMIT;')
      expect(syncScript).toContain('statement.sql')
      expect(syncScript).not.toContain('capgo_read_replica_schema_owner')
      expect(syncScript).not.toContain('bootstrap-read-replica-schema-owner')
      expect(syncScript).not.toContain('CREATE ROLE')
      expect(syncScript).not.toContain(' OWNER TO ')
      expect(syncScript).not.toContain('SET LOCAL ROLE')
      expect(syncScript).not.toContain('CREATE FUNCTION')
      expect(syncScript).not.toContain('SECURITY DEFINER')
      expect(syncScript).not.toContain('GRANT ')
      expect(syncScript).not.toContain('REVOKE ')
      expect(syncScript).not.toContain('capgo_internal')
      expect(syncScript).not.toContain('ReadReplicaSchemaOwnerOperation')
      expect(syncScript).not.toContain('renderReadReplicaOwnerExecutor')
      expect(syncScript).not.toContain('googleDataApiConfigFromArgs')
      expect(catalogFromMigrations).toContain('createPgliteEngine')
      expect(catalogFromMigrations).toContain('loadSupabaseProject')
      expect(catalogFromMigrations).toContain('runMigrations(project.migrations)')
      expect(catalogFromMigrations).not.toContain('schema_replicate.catalog.json')
      expect(catalogFromMigrations).not.toContain('supabase db')
      expect(catalogFromMigrations).not.toContain('docker')
    },
  )

  it.concurrent(
    'holds downstream release publishing behind the replica gate',
    async () => {
      const workflow = await readReleaseWorkflow()

      for (const job of [
        'deploy_webapp',
        'deploy_api',
        'deploy_translation_worker',
        'deploy_files',
        'deploy_plugin_regions',
      ]) {
        expect(workflow).toContain(
          `  ${job}:\n    needs: [changes, supabase_deploy, read_replica_schema]`,
        )
      }
    },
  )

  it(
    'builds the release catalog from all local migrations through PGlite',
    async () => {
      const catalog = await readReplicaSchemaCatalogFromMigrations() as {
        tables: Array<{ name: string }>
      }

      expect(catalog.tables.map(table => table.name)).toEqual(
        [...REPLICA_TABLES].sort(),
      )
    },
    30_000,
  )
})
