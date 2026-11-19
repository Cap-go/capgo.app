import { z } from 'zod'

export const pluginRegions = [
  { region: 'eu', region_label: 'Europe (EU)', cf_target: 'plugin_eu' },
  { region: 'as', region_label: 'Asia (AS)', cf_target: 'plugin_as' },
  { region: 'us', region_label: 'United States (US)', cf_target: 'plugin_na' },
  { region: 'sa', region_label: 'South America (SA)', cf_target: 'plugin_sa' },
  { region: 'oc', region_label: 'Oceania (OC)', cf_target: 'plugin_oc' },
  { region: 'af', region_label: 'Africa (AF)', cf_target: 'plugin_af' },
  { region: 'me', region_label: 'Middle East (ME)', cf_target: 'plugin_me' },
  { region: 'hk', region_label: 'Hong Kong (HK)', cf_target: 'plugin_hk' },
  { region: 'jp', region_label: 'Japan (JP)', cf_target: 'plugin_jp' },
] as const
export const evidenceSchema = z.object({
  tag: z.string().regex(/^capgo-\d+\.\d+\.\d+(?:-alpha\.\d+)?$/),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.string().regex(/^[1-9]\d*$/),
  attempt: z.number().int().positive(),
}).strict()
export type Evidence = z.infer<typeof evidenceSchema>
const entrySchema = z.object({ success: evidenceSchema.nullable(), pending: evidenceSchema.nullable() }).strict()
export const stateSchema = z.object({
  version: z.literal(1),
  environment: z.enum(['stable', 'alpha']),
  entries: z.record(z.string(), entrySchema),
}).strict().superRefine((state, ctx) => {
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!keysForEnvironment(state.environment).includes(key))
      ctx.addIssue({ code: 'custom', message: `Unexpected deployment key: ${key}` })
    for (const evidence of [entry.success, entry.pending]) {
      if (evidence && evidence.tag.includes('-alpha.') !== (state.environment === 'alpha'))
        ctx.addIssue({ code: 'custom', message: 'Evidence environment mismatch' })
    }
  }
})
export type DeploymentState = z.infer<typeof stateSchema>
export type Environment = DeploymentState['environment']
export type IsAncestor = (base: string, head: string) => boolean

export function keysForEnvironment(environment: Environment): string[] {
  return environment === 'alpha'
    ? ['supabase', 'api', 'translation', 'files', 'plugins_alpha']
    : ['supabase', 'api', 'translation', 'files', 'gotrue', ...pluginRegions.map(({ region }) => `plugins_${region}`)]
}

export function pluginMatrix(environment: Environment) {
  return { include: environment === 'alpha' ? [{ region: 'alpha', region_label: 'alpha', cf_target: 'plugin' }] : [...pluginRegions] }
}

export function emptyState(environment: Environment): DeploymentState {
  return { version: 1, environment, entries: {} }
}

export function sameAttempt(a: Evidence, b: Evidence): boolean {
  return a.sha === b.sha && a.tag === b.tag && a.runId === b.runId && a.attempt === b.attempt
}

export function beginDeployment(state: DeploymentState, evidence: Evidence, keys: string[], isAncestor: IsAncestor): DeploymentState {
  const next = stateSchema.parse(structuredClone(state))
  for (const key of keys) {
    if (!keysForEnvironment(state.environment).includes(key))
      throw new Error(`Invalid deployment key: ${key}`)
    const previous = next.entries[key]
    for (const prior of [previous?.success, previous?.pending]) {
      if (prior && (!isAncestor(prior.sha, evidence.sha) || (prior.runId === evidence.runId && prior.attempt > evidence.attempt)))
        throw new Error('Refusing a regressing deployment attempt')
    }
    next.entries[key] = { success: previous?.success ?? null, pending: evidence }
  }
  return stateSchema.parse(next)
}

export function completeDeployment(state: DeploymentState, evidence: Evidence, completedKeys: string[]): DeploymentState {
  const next = stateSchema.parse(structuredClone(state))
  for (const key of completedKeys) {
    const entry = next.entries[key]
    if (!entry?.pending || !sameAttempt(entry.pending, evidence))
      throw new Error('Completion does not match the immutable pending deployment attempt')
    next.entries[key] = { success: evidence, pending: null }
  }
  return stateSchema.parse(next)
}

const stepSchema = z.object({ name: z.string(), conclusion: z.string().nullable(), completed_at: z.string().nullable() })
export const jobSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  steps: z.array(stepSchema),
})
export type DeploymentJob = z.infer<typeof jobSchema>

// Require the operation itself, never overall workflow success or a skipped job.
export function completedDeploymentKeys(jobs: DeploymentJob[], environment: Environment): string[] {
  const succeeded = (jobName: string, stepName: string) => {
    const matches = jobs.filter(job => job.name === jobName)
    return matches.length === 1 && matches.every(job => job.status === 'completed' && job.conclusion !== 'skipped'
      && job.steps.some(step => step.name === stepName && step.conclusion === 'success' && step.completed_at !== null))
  }
  const keys: string[] = []
  if (succeeded('Build code and deploy to Supabase', 'Update functions')
    && succeeded('Build code and deploy to Supabase', 'Apply Supabase Migrations')
    && (environment === 'alpha' || (
      succeeded('Reconcile production read-replica schema', 'Reconcile the Google subscriber through server-side Cloud SQL import')
      && succeeded('Refresh read-replica subscription', 'Refresh subscription for newly published tables')
    ))) {
    keys.push('supabase')
  }
  if (succeeded('deploy_api', 'Deploy CF Worker API')
    && (environment === 'alpha' || succeeded('deploy_api', 'Retire removed CF Workers'))) {
    keys.push('api')
  }
  for (const [key, name, step] of [
    ['translation', 'deploy_translation_worker', 'Deploy CF Worker Translation'],
    ['files', 'deploy_files', 'Deploy CF Worker Files'],
    ['gotrue', 'deploy_gotrue_worker', 'Deploy CF Worker GoTrue'],
  ]) {
    if (keysForEnvironment(environment).includes(key) && succeeded(name, step))
      keys.push(key)
  }
  if (environment === 'alpha') {
    if (succeeded('Deploy CF Worker Plugin (alpha)', 'Deploy CF Worker Plugin'))
      keys.push('plugins_alpha')
  }
  else {
    for (const { region, region_label } of pluginRegions) {
      if (succeeded(`Deploy CF Worker Plugin (${region_label})`, 'Deploy CF Worker Plugin'))
        keys.push(`plugins_${region}`)
    }
  }
  return keys
}
