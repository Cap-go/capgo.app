import type { OptionsBase } from '../schemas/base'
import { stdin, stdout } from 'node:process'
import { intro, log, outro, spinner } from '@clack/prompts'
import { check2FAComplianceForApp } from '../api/app'
import { CliUserError } from '../shared/cli-user-error'
import { createSupabaseClient, findSavedKey, formatCapgoCliInvokeError, getAppId, getCapgoCliHttpStatus, getConfig, invokeCapgoCliApi } from '../utils'

const V2_STEP_IDS = [
  'login_cli_mcp', 'add_channel', 'add_updater', 'add_code', 'add_encryption',
  'select_platform', 'build_project', 'run_device', 'add_code_change',
  'upload_bundle', 'test_update', 'completion',
] as const

const V3_STEP_IDS = [
  'login_cli_mcp', 'add_channel', 'add_updater', 'add_code',
  'run_device', 'upload_bundle', 'test_update',
] as const

const STEP_TITLES = {
  add_app: 'Add your app',
  login_cli_mcp: 'Log in to the Capgo CLI/MCP',
  add_channel: 'Create a channel',
  add_updater: 'Install updater plugin',
  add_code: 'Add integration code',
  add_encryption: 'Setup encryption',
  select_platform: 'Select platform',
  build_project: 'Build your project',
  run_device: 'Run on device',
  add_code_change: 'Make a test change',
  upload_bundle: 'Upload bundle',
  test_update: 'Test update on device',
  completion: 'Completion',
}

const V3_STEP_TITLES: Record<typeof V3_STEP_IDS[number], string> = {
  login_cli_mcp: 'Start guided setup',
  add_channel: 'Create a channel',
  add_updater: 'Install Capgo Updater',
  add_code: 'Add the app-ready code',
  run_device: 'Run your app on a device',
  upload_bundle: 'Publish your first update',
  test_update: 'Deliver an update to a device',
}

export interface AppTodoProgress {
  onboarding: unknown
  hasChannel?: boolean
  checkErrors?: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function getAppTodoSteps(progress: AppTodoProgress) {
  const raw = asRecord(progress.onboarding)
  const setup = raw.setup !== null && typeof raw.setup === 'object' && !Array.isArray(raw.setup)
    ? asRecord(raw.setup)
    : raw
  const version = typeof setup.todo_list_version === 'number' && Number.isSafeInteger(setup.todo_list_version) && setup.todo_list_version > 0
    ? setup.todo_list_version
    : 2
  const ids: readonly (keyof typeof STEP_TITLES)[] = version === 3
    ? V3_STEP_IDS
    : version === 1 ? ['add_app', ...V2_STEP_IDS.slice(1)] : V2_STEP_IDS
  const reportedSteps = asRecord(setup.steps)
  const steps = ids.map((id) => {
    const reportedStatus = asRecord(reportedSteps[id]).status
    let status: 'done' | 'skipped' | 'pending' = reportedStatus === 'done' || reportedStatus === 'skipped' ? reportedStatus : 'pending'
    // Match the frontend's live channel override, including deleted channels.
    if (id === 'add_channel' && typeof progress.hasChannel === 'boolean')
      status = progress.hasChannel ? 'done' : 'pending'
    const title = version === 3 ? V3_STEP_TITLES[id as keyof typeof V3_STEP_TITLES] : STEP_TITLES[id]
    return { id, title, status }
  })
  return { version, steps }
}

export function formatAppTodoList(appId: string, progress: AppTodoProgress): string {
  const { version, steps } = getAppTodoSteps(progress)
  const done = steps.filter(step => step.status === 'done').length
  const skipped = steps.filter(step => step.status === 'skipped').length
  const markers = { done: '[x] Done', skipped: '[-] Skipped', pending: '[ ] Pending' }
  return [
    `App: ${appId} — Todo list v${version}`,
    `${done + skipped}/${steps.length} completed (${done} done, ${skipped} skipped, ${steps.length - done - skipped} pending)`,
    '',
    ...steps.map(step => `${markers[step.status]}: ${step.title}`),
  ].join('\n')
}

export async function readAppTodoProgress(appId: string, options: OptionsBase): Promise<AppTodoProgress> {
  const { data, error } = await invokeCapgoCliApi<AppTodoProgress>('private/onboarding_progress', {
    ...options,
    body: { appId, N: 0, initial: true },
    signal: AbortSignal.timeout(15_000),
  })
  if (error) {
    const status = getCapgoCliHttpStatus(error)
    if (status === 401 || status === 403) {
      throw new CliUserError('Cannot access app todo list. Check that your API key is valid and has app.read permission for this app.', {
        appId, requiredPermissionKey: 'app.read',
      })
    }
    if (status === 404)
      throw new CliUserError('App not found.', { appId })
    throw new Error(`Cannot read app todo list: ${await formatCapgoCliInvokeError(error)}`, { cause: error })
  }
  if (!data || !Object.hasOwn(data, 'onboarding'))
    throw new Error('Cannot read app todo list: invalid progress response')
  return data
}

export async function appTodo(appId: string | undefined, options: Partial<OptionsBase>) {
  intro('App todo list')
  const apikey = options.apikey || findSavedKey()
  if (!apikey) {
    const message = 'Missing API key. Provide --apikey or log in.'
    log.error(message)
    throw new CliUserError(message)
  }
  if (!appId)
    appId = getAppId(undefined, (await getConfig()).config)
  if (!appId) {
    const message = 'Missing appId. Provide an app ID or run this command in a Capacitor project.'
    log.error(message)
    throw new CliUserError(message)
  }

  const supabase = await createSupabaseClient(apikey, options.supaHost, options.supaAnon)
  const loading = stdin.isTTY && stdout.isTTY ? spinner() : null
  if (loading)
    loading.start('Loading the todo list')
  else
    log.info('Loading the todo list')

  let progress: AppTodoProgress
  try {
    await check2FAComplianceForApp(supabase, appId)
    progress = await readAppTodoProgress(appId, { ...options, apikey })
    loading?.stop('Todo list loaded')
  }
  catch (error) {
    loading?.stop('Could not load todo list')
    if (error instanceof CliUserError)
      log.error(error.message)
    throw error
  }
  if (progress.checkErrors?.length)
    log.warn('Some live progress checks failed. Showing saved progress for those tasks; try again to refresh them.')
  log.info(formatAppTodoList(appId, progress))
  outro('Done ✅')
}
