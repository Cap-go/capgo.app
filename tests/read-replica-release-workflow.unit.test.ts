/* eslint-disable no-template-curly-in-string -- Tests assert literal GitHub Actions expressions. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
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
      expect(workflow).not.toContain('secrets.READ_REPLICATE_GOOGLE_EU1')
      expect(workflow).not.toContain('Missing READ_REPLICATE_GOOGLE_EU1')
      expect(workflow).toContain('gcloud config set project capgo-394818')
      expect(workflow).not.toContain('preload_replica_env')
      expect(workflow).not.toContain('check-read-replica-hyperdrive-schema')
      expect(workflow).toContain('sync-read-replica-schema.ts --apply --allow-drop')
      expect(workflow).toContain('read_replica_subscription:')
      expect(workflow).toContain('sync-read-replica-schema.ts --refresh-subscription')
      expect(workflow).toContain('sync-read-replica-schema.ts --guard')
      // Reconciliation runs in supabase_deploy before migrations, so a failed reconcile stops
      // the migrations and everything that waits on supabase_deploy.
      expect(workflow).toContain('supabase_deploy:\n    needs: [changes]')
      const supabaseJob = workflow.slice(workflow.indexOf('\n  supabase_deploy:'), workflow.indexOf('\n  read_replica_subscription:'))
      const reconcileIndex = supabaseJob.indexOf('sync-read-replica-schema.ts --apply --allow-drop')
      expect(reconcileIndex).toBeGreaterThan(-1)
      expect(reconcileIndex).toBeLessThan(supabaseJob.indexOf('push-release-migrations.sh'))
      expect(supabaseJob.indexOf('push-release-migrations.sh')).toBeLessThan(supabaseJob.indexOf('sync-read-replica-schema.ts --guard'))
      expect(supabaseJob.indexOf('sync-read-replica-schema.ts --guard')).toBeLessThan(supabaseJob.indexOf('sync-read-replica-schema.ts --refresh-subscription'))
      expect(workflow).not.toContain('read_replica_schema')
      expect(workflow).toContain('needs.supabase_deploy.result == \'success\'')
      // The sync script must preflight subscriber compatibility before applying anything.
      // Import-path internals are covered by read-replica-schema-import-sync.unit.test.ts.
      expect(syncScript).toContain('preflightCompatibilityIssues')
      expect(syncScript).toContain('await applyPlan(plan)')
      expect(syncScript.indexOf('preflightCompatibilityIssues')).toBeLessThan(
        syncScript.indexOf('await applyPlan(plan)'),
      )
      expect(syncScript).toContain('readReplicaSchemaCatalogFromMigrations')
      expect(syncScript).toContain('gcloud sql execute-sql (GOOGLE_SERVICE_ACCOUNT)')
      expect(syncScript).toContain('loadLocalReadReplicaEnvIfNeeded')
    },
  )

  it.concurrent(
    'holds downstream release publishing behind the replica gate',
    async () => {
      const workflow = await readReleaseWorkflow()

      expect(workflow).toMatch(
        /\n  deploy_webapp:\n    needs: \[changes, build_webapp, supabase_deploy, read_replica_subscription\]/,
      )
      for (const job of [
        'deploy_api',
        'deploy_translation_worker',
        'deploy_files',
        'deploy_plugin_regions',
      ]) {
        expect(workflow).toMatch(
          new RegExp(`\\n  ${job}:\\n    needs: \\[changes, supabase_deploy\\]`),
        )
      }
      // Subscription refresh stays a visible release step but must not gate worker deploys.
      expect(workflow).toContain('read_replica_subscription:')
      const refreshJob = workflow.slice(
        workflow.indexOf('\n  read_replica_subscription:'),
        workflow.indexOf('\n  build_webapp:'),
      )
      expect(refreshJob).toContain(
        githubExpression('always() && needs.changes.result == \'success\' && needs.changes.outputs.supabase == \'true\' && needs.changes.outputs.is_alpha != \'true\' && needs.supabase_deploy.result == \'success\''),
      )
      expect(workflow).not.toMatch(
        /deploy_(?:api|files|plugin_regions):\n    needs:.*read_replica_subscription/,
      )

      interface Step { 'id'?: string, 'run'?: string, 'continue-on-error'?: boolean, 'parallel'?: Step[] }
      const parsed = parse(workflow) as {
        jobs?: Record<string, { if?: unknown, needs?: string[] | string, outputs?: Record<string, string>, steps?: Step[] }>
      }
      const refreshDef = parsed.jobs?.read_replica_subscription
      expect(refreshDef, 'read_replica_subscription must exist in build_and_deploy.yml').toBeDefined()
      expect(refreshDef?.if, 'read_replica_subscription must keep a job-level if').toBeDefined()
      expect(refreshDef?.if, 'read_replica_subscription must not be disabled with if: false').not.toBe(false)
      // The refresh itself runs in supabase_deploy next to the function deploys. It asserts the
      // deploy tag is current, cannot fail that job, and the gate job turns its outcome into a
      // visible failure that holds web publishing.
      const refreshStep = (parsed.jobs?.supabase_deploy?.steps ?? [])
        .flatMap(step => [step, ...(step.parallel ?? [])])
        .find(step => step.id === 'replica_subscription')
      expect(refreshStep?.run).toContain('resolve-deploy-tag.ts --assert-current')
      expect(refreshStep?.run).toContain('sync-read-replica-schema.ts --refresh-subscription')
      expect(refreshStep?.['continue-on-error']).toBe(true)
      expect(parsed.jobs?.supabase_deploy?.outputs?.replica_subscription).toBe(githubExpression('steps.replica_subscription.outcome'))
      expect(refreshDef?.steps?.some(step => step.run?.includes('[ "$OUTCOME" != "success" ]') && step.run.includes('exit 1'))).toBe(true)
      const workerJobs = ['deploy_api', 'deploy_files', 'deploy_plugin_regions', 'deploy_translation_worker'] as const
      const expectedIf: Record<typeof workerJobs[number], string> = {
        deploy_api: githubExpression('always() && needs.changes.result == \'success\' && needs.changes.outputs.api == \'true\' && (needs.supabase_deploy.result == \'success\' || needs.supabase_deploy.result == \'skipped\')'),
        deploy_translation_worker: githubExpression('always() && needs.changes.result == \'success\' && needs.changes.outputs.translation == \'true\' && (needs.supabase_deploy.result == \'success\' || (needs.supabase_deploy.result == \'skipped\' && needs.changes.outputs.supabase != \'true\'))'),
        deploy_files: githubExpression('always() && needs.changes.result == \'success\' && needs.changes.outputs.files == \'true\' && (needs.supabase_deploy.result == \'success\' || needs.supabase_deploy.result == \'skipped\')'),
        deploy_plugin_regions: githubExpression('always() && needs.changes.result == \'success\' && needs.changes.outputs.plugins == \'true\' && (needs.supabase_deploy.result == \'success\' || needs.supabase_deploy.result == \'skipped\')'),
      }
      for (const job of workerJobs) {
        const jobDef = parsed.jobs?.[job]
        expect(jobDef, `${job} must exist in build_and_deploy.yml`).toBeDefined()
        const needs = jobDef?.needs
        const needsList = Array.isArray(needs) ? needs : needs ? [needs] : []
        expect(needsList, `${job} must not need read_replica_subscription`).not.toContain('read_replica_subscription')
        expect(jobDef?.if, `${job} must keep a job-level if`).toBeDefined()
        expect(jobDef?.if, `${job} must not be disabled with if: false`).not.toBe(false)
        expect(jobDef?.if, `${job} must keep its expected if`).toBe(expectedIf[job])
        expect(String(jobDef?.if), `${job} must not gate on read_replica_subscription`).not.toContain('read_replica_subscription')
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
