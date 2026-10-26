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

function githubExpression(value: string): string {
  return '$' + `{{ ${value} }}`
}

async function readReleaseWorkflow(): Promise<string> {
  return readFile(workflowUrl, 'utf8')
}

async function readReplicaSyncScript(): Promise<string> {
  return readFile(syncScriptUrl, 'utf8')
}

describe('production read-replica release gate', () => {
  it.concurrent(
    'rebuilds the catalog locally and imports only a fully preflighted atomic plan before primary migrations',
    async () => {
      const [workflow, syncScript] = await Promise.all([
        readReleaseWorkflow(),
        readReplicaSyncScript(),
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
          `    if: ${githubExpression('needs.changes.result == \'success\' && needs.changes.outputs.supabase == \'true\' && needs.changes.outputs.is_alpha != \'true\'')}`,
        ].join('\n'),
      )
      expect(workflow).toContain(
        'supabase_deploy:\n    needs: [changes, read_replica_schema]',
      )
      expect(workflow).toContain(
        'sync_schema_types:\n    needs: [changes, read_replica_schema, supabase_deploy]',
      )
      expect(workflow).toContain('needs.read_replica_schema.result == \'success\'')
      expect(workflow).toContain('needs.supabase_deploy.result == \'success\'')
      // The sync script must preflight subscriber compatibility before applying anything.
      // Import-path internals are covered by read-replica-schema-import-sync.unit.test.ts.
      expect(syncScript.indexOf('preflightCompatibilityIssues')).toBeLessThan(
        syncScript.indexOf('await applyPlan(plan)'),
      )
      expect(syncScript).toContain('readReplicaSchemaCatalogFromMigrations')
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
        expect(workflow).toMatch(
          new RegExp(`\\n  ${job}:\\n    needs: \\[changes, (?:build_webapp, )?supabase_deploy, read_replica_schema\\]`),
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
