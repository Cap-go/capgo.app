import type { OptionsBase } from '../schemas/base'
import type { AgentTrial } from '../shared/agent-notices'
import { env, stdout } from 'node:process'
import { intro, log, outro, spinner } from '@clack/prompts'
import { check2FAComplianceForApp } from '../api/app'
import { getPendingOnboardingChecks } from '../onboarding/background-workers'
import { getAgentTrial } from '../onboarding/setup-notices'
import { formatAgentTodoTrialItem, isAgentInvocation, printAgentText } from '../shared/agent-notices'
import { CliUserError } from '../shared/cli-user-error'
import { canPromptInteractively, createCapgoClient, findSavedKey, formatCapgoCliInvokeError, getAppId, getCapgoCliHttpStatus, getConfig, getRemoteConfig, invokeCapgoCliApi } from '../utils'
import { formatBuilderOnlyChecklist, getBuilderChecklist, getBuilderOnlyChecklist } from './builder-checklist'

export type AppTodoList = 'builder' | 'ota'

interface AppTodoOptions extends Partial<OptionsBase> {
  list?: string
}

const V2_STEP_IDS = [
  'login_cli_mcp',
  'add_channel',
  'add_updater',
  'add_code',
  'add_encryption',
  'select_platform',
  'build_project',
  'run_device',
  'add_code_change',
  'upload_bundle',
  'test_update',
  'completion',
] as const

const V3_STEP_IDS = [
  'login_cli_mcp',
  'add_channel',
  'add_updater',
  'add_code',
  'run_device',
  'upload_bundle',
  'test_update',
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

const V3_NEXT_STEP_HELP: Record<typeof V3_STEP_IDS[number], { action: string, doneWhen: string }> = {
  login_cli_mcp: {
    action: 'Run a Capgo CLI command or start the MCP guided setup as the app creator.',
    doneWhen: 'Capgo records that CLI or MCP activity for the app creator.',
  },
  add_channel: {
    action: 'Create a channel for this app to receive live updates.',
    doneWhen: 'Capgo finds a channel for this app.',
  },
  add_updater: {
    action: 'Install @capgo/capacitor-updater in your app project.',
    doneWhen: 'The CLI finds the dependency declared and installed, then reports it to Capgo.',
  },
  add_code: {
    action: 'Call CapacitorUpdater.notifyAppReady() once your app is ready after an update.',
    doneWhen: 'The CLI finds that call in your app source and reports it to Capgo.',
  },
  run_device: {
    action: 'Build and open the app on a device or simulator with Capgo installed.',
    doneWhen: 'Capgo sees a device connect to this app.',
  },
  upload_bundle: {
    action: 'Build and upload your first live update bundle.',
    doneWhen: 'Capgo finds a published bundle for this app.',
  },
  test_update: {
    action: 'Assign the update to a channel, then reopen the app on a device.',
    doneWhen: 'Capgo records a device applying an uploaded version.',
  },
}

export interface AppTodoProgress {
  onboarding: unknown
  hasChannel?: boolean
  checkErrors?: string[]
  billing?: unknown
}

export const TODO_BACKGROUND_WAIT_MS = 10_000

export async function waitForTodoBackgroundChecks(
  checks: readonly Promise<void>[],
  onCountdown?: (remainingSeconds: number) => void,
  timeoutMs = TODO_BACKGROUND_WAIT_MS,
): Promise<boolean> {
  if (!checks.length)
    return true

  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let countdown: ReturnType<typeof setInterval> | undefined
  let remaining = Math.ceil(timeoutMs / 1_000)
  onCountdown?.(remaining)
  if (onCountdown) {
    countdown = setInterval(() => {
      const next = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))
      if (next !== remaining) {
        remaining = next
        onCountdown(next)
      }
    }, 1_000)
  }

  try {
    return await Promise.race([
      Promise.allSettled(checks).then(() => true),
      new Promise<false>((resolve) => {
        // Keep the process alive while the background workers remain unreferenced.
        timer = setTimeout(resolve, timeoutMs, false)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
    if (countdown)
      clearInterval(countdown)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function getAvailableAppTodoLists(progress: AppTodoProgress): AppTodoList[] {
  if (getBuilderOnlyChecklist(progress.onboarding))
    return ['builder']
  const raw = asRecord(progress.onboarding)
  const setup = Object.hasOwn(raw, 'setup') ? asRecord(raw.setup) : raw
  if (setup.ota_todo_list_version === '1' && Array.isArray(setup.paths)
    && setup.paths.includes('ota') && getBuilderChecklist(progress.onboarding)) {
    return ['ota', 'builder']
  }
  return ['ota']
}

export function resolveAppTodoView(progress: AppTodoProgress, options: { list?: string, interactive: boolean }): { list: AppTodoList, tabs: boolean } {
  const available = getAvailableAppTodoLists(progress)
  if (options.list !== undefined) {
    if (options.list !== 'builder' && options.list !== 'ota')
      throw new CliUserError('Unknown todo list. Choose --list builder or --list ota.')
    if (!available.includes(options.list))
      throw new CliUserError(`${options.list === 'builder' ? 'Builder' : 'OTA'} todo list is not available for this app. Use --list ${available[0]}.`)
    return { list: options.list, tabs: false }
  }
  if (available.length === 1)
    return { list: available[0], tabs: false }
  if (!options.interactive)
    throw new CliUserError('This app has both Builder and OTA todo lists. In non-interactive mode, choose one with --list builder or --list ota.')
  const raw = asRecord(progress.onboarding)
  const setup = Object.hasOwn(raw, 'setup') ? asRecord(raw.setup) : raw
  return { list: setup.selected_path === 'builder' ? 'builder' : 'ota', tabs: true }
}

export function getAppTodoSteps(progress: AppTodoProgress, list?: AppTodoList) {
  if (list)
    resolveAppTodoView(progress, { list, interactive: false })
  const builder = list === 'builder'
    ? getBuilderChecklist(progress.onboarding)
    : list === 'ota' ? null : getBuilderOnlyChecklist(progress.onboarding)
  if (builder)
    return builder
  const raw = asRecord(progress.onboarding)
  const setup = raw.setup !== null && typeof raw.setup === 'object' && !Array.isArray(raw.setup)
    ? asRecord(raw.setup)
    : raw
  const version = typeof setup.todo_list_version === 'number' && Number.isSafeInteger(setup.todo_list_version) && setup.todo_list_version > 0
    ? setup.todo_list_version
    : 2
  const otaV1 = version === 4 && setup.ota_todo_list_version === '1'
  // TODO(2027-03-19): Remove v3 flat-step compatibility after existing apps migrate.
  const ids: readonly (keyof typeof STEP_TITLES)[] = version === 3 || otaV1
    ? V3_STEP_IDS
    : version === 4 ? [] : version === 1 ? ['add_app', ...V2_STEP_IDS.slice(1)] : V2_STEP_IDS
  const reportedSteps = otaV1 ? asRecord(asRecord(setup.steps).ota) : asRecord(setup.steps)
  const steps = ids.map((id) => {
    const reportedStatus = asRecord(reportedSteps[id]).status
    let status: 'done' | 'skipped' | 'pending' = reportedStatus === 'done' || reportedStatus === 'skipped' ? reportedStatus : 'pending'
    // Match the frontend's live channel override, including deleted channels.
    if (id === 'add_channel' && typeof progress.hasChannel === 'boolean')
      status = progress.hasChannel ? 'done' : 'pending'
    const title = version === 3 || otaV1 ? V3_STEP_TITLES[id as keyof typeof V3_STEP_TITLES] : STEP_TITLES[id]
    return { id, title, status }
  })
  return { version, steps, path: 'ota' as const, selectedPlatform: undefined }
}

export function formatAppTodoList(appId: string, progress: AppTodoProgress, options: { color?: boolean, list?: AppTodoList, trial?: AgentTrial } = {}): string {
  const checklist = getAppTodoSteps(progress, options.list)
  if (checklist.path === 'builder')
    return formatBuilderOnlyChecklist(appId, checklist, options)
  const { version, steps } = checklist
  if (version === 4 && steps.length === 0)
    return `App: ${appId} — Todo list v4\nThis CLI does not support this OTA checklist version.`
  const done = steps.filter(step => step.status === 'done').length
  const skipped = steps.filter(step => step.status === 'skipped').length
  const markers = { done: '[x] Done', skipped: '[-] Skipped', pending: '[ ] Pending' }
  const colors = { done: '32', skipped: '2', pending: '33' }
  const colorize = (value: string, code: string) => options.color ? `\u001B[${code}m${value}\u001B[0m` : value
  const next = getAppTodoNextStep(progress, options.list)
  return [
    colorize(`App: ${appId} — Todo list v${version}${options.list === 'ota' ? ' — OTA checklist' : ''}`, '1'),
    `${done + skipped}/${steps.length} completed (${done} done, ${skipped} skipped, ${steps.length - done - skipped} pending)`,
    '',
    ...steps.map(step => `${colorize(markers[step.status], colors[step.status])}: ${step.title}`),
    ...(options.trial ? [formatAgentTodoTrialItem(options.trial)] : []),
    ...(next
      ? [
          '',
          colorize(`Next step: ${next.title}`, '1;36'),
          `  ${next.action}`,
          `  Done when: ${next.doneWhen}`,
          '  Run this command again to recheck progress.',
        ]
      : []),
  ].join('\n')
}

export function getAppTodoNextStep(progress: AppTodoProgress, list?: AppTodoList) {
  const { version, path, steps } = getAppTodoSteps(progress, list)
  if (path !== 'ota' || (version !== 3 && version !== 4))
    return
  const next = steps.find(step => step.status === 'pending')
  return next ? { ...next, ...V3_NEXT_STEP_HELP[next.id as typeof V3_STEP_IDS[number]] } : undefined
}

export async function readAppTodoProgress(appId: string, options: OptionsBase): Promise<AppTodoProgress> {
  const { data, error } = await invokeCapgoCliApi<AppTodoProgress>('private/onboarding_progress', {
    ...options,
    body: { appId, N: 0, initial: true, ...(isAgentInvocation() ? { includeBilling: true } : {}) },
    signal: AbortSignal.timeout(15_000),
  })
  if (error) {
    const status = getCapgoCliHttpStatus(error)
    if (status === 401 || status === 403) {
      throw new CliUserError('Cannot access app todo list. Check that your API key is valid and has app.read permission for this app.', {
        appId,
        requiredPermissionKey: 'app.read',
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

export async function appTodo(appId: string | undefined, options: AppTodoOptions) {
  // Snapshot before the first API read so a check finishing during that read still triggers a refresh.
  const backgroundChecks = [...getPendingOnboardingChecks().values()].map(check => check.completion)
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

  const client = await createCapgoClient(apikey, options.apiHost)
  const interactive = canPromptInteractively()
  const loading = interactive ? spinner() : null
  if (loading)
    loading.start('Loading the todo list')
  else
    log.info('Loading the todo list')

  let progress: AppTodoProgress
  try {
    await check2FAComplianceForApp(client, appId)
    progress = await readAppTodoProgress(appId, { ...options, apikey })
    loading?.stop('Todo list loaded')
  }
  catch (error) {
    loading?.stop('Could not load todo list')
    if (error instanceof CliUserError)
      log.error(error.message)
    throw error
  }
  const resolveView = () => {
    try {
      return resolveAppTodoView(progress, { list: options.list, interactive })
    }
    catch (error) {
      if (error instanceof CliUserError)
        log.error(error.message)
      throw error
    }
  }
  let view = resolveView()
  const { version, steps } = getAppTodoSteps(progress, view.list)
  const checks = (view.tabs || view.list === 'ota') && (version === 3 || (version === 4 && steps.length > 0)) ? backgroundChecks : []
  if (checks.length) {
    const waiting = interactive ? spinner() : null
    const waitMessage = (seconds: number) => `Waiting ${seconds} seconds for background TODO list checks to finish`
    if (!waiting)
      log.info(waitMessage(10))
    let started = false
    const finished = await waitForTodoBackgroundChecks(checks, waiting
      ? (seconds) => {
          if (started) {
            waiting.message(waitMessage(seconds))
          }
          else {
            waiting.start(waitMessage(seconds))
            started = true
          }
        }
      : undefined)
    waiting?.stop(finished ? 'Background TODO list checks finished' : 'Finished waiting for background TODO list checks')

    const refreshing = interactive ? spinner() : null
    if (refreshing)
      refreshing.start('Refreshing the todo list')
    else
      log.info('Refreshing the todo list')
    try {
      progress = await readAppTodoProgress(appId, { ...options, apikey })
      refreshing?.stop('Todo list refreshed')
    }
    catch (error) {
      refreshing?.stop('Could not refresh todo list')
      if (error instanceof CliUserError)
        log.error(error.message)
      throw error
    }
  }
  if (progress.checkErrors?.length)
    log.warn('Some live progress checks failed. Showing saved progress for those tasks; try again to refresh them.')
  view = resolveView()
  const color = !!stdout.isTTY && env.NO_COLOR === undefined
  let selectedList = view.list
  if (view.tabs) {
    const { showAppTodoTabs } = await import('./todo-tabs')
    selectedList = await showAppTodoTabs({
      initialList: view.list,
      color,
      lists: getAvailableAppTodoLists(progress).map((list) => {
        const { steps } = getAppTodoSteps(progress, list)
        return {
          id: list,
          completed: steps.filter(step => step.status === 'done' || step.status === 'skipped').length,
          total: steps.length,
          content: formatAppTodoList(appId, progress, { list, color }),
        }
      }),
    })
  }
  if (isAgentInvocation())
    printAgentText(formatAppTodoList(appId, progress, { list: selectedList, trial: getAgentTrial(progress, (await getRemoteConfig(true)).hostWeb) }))
  else
    log.info(formatAppTodoList(appId, progress, { list: selectedList, color }))
  outro('Done ✅')
}
