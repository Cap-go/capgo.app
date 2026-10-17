import { APP_ONBOARDING_ADD_CODE_INFERRED_ANNOTATION, APP_ONBOARDING_OTA_V1_STEP_IDS } from '../../../../supabase/functions/_backend/utils/appOnboarding.ts'

export type Product = 'ota' | 'builder'
type Platform = 'ios' | 'android'
type TaskStatus = 'done' | 'pending' | 'skipped' | 'unknown' | 'warning'

export interface Fact {
  id: string
  at: string
  step: string
  kind: 'task' | 'value'
  acknowledgement: string
}

export interface AppEvidence {
  appId: string
  incarnation: string
  createdAt: string
  name: string
  product: Product
  platform: Platform | null
  selected: boolean
  healthy: boolean
  activeUntil: string | null
  facts: Fact[]
  tasks: Record<string, TaskStatus>
  checklistComplete: boolean
  firstValue: Fact | null
  fundingBlocked: boolean
}

export interface VerifiedAppOutcomes {
  otaAppliedAt?: string | null
  otaBundleId?: string | null
  builderSucceededAt?: string | null
  builderJobId?: string | null
  runningUntil?: string | null
  /** Outcome-specific demo provenance, resolved from onboarding_demo_data and legacy markers. */
  demoApp?: boolean
}

export interface LifecycleAppRow {
  app_id: string
  id: string
  created_at: string
  name: string | null
  onboarding: unknown
  need_onboarding: boolean
}

// The canonical Builder v1 checklist is also consumed by the console's
// src/services/builderOnboardingChecklist.ts. Platform facts never cross paths.
const BUILDER_STEPS = {
  ios: ['start_setup', 'choose_destination', 'connect_app_store', 'prepare_certificate', 'prepare_profile', 'successful_cloud_build'],
  android: ['start_setup', 'prepare_keystore', 'connect_google_play', 'successful_cloud_build'],
} as const

const ACKNOWLEDGEMENTS: Record<string, string> = {
  login_cli_mcp: 'Connected the Capgo CLI or MCP',
  add_channel: 'Created the channel',
  add_updater: 'Installed Capacitor Updater',
  add_code: 'Added the update code',
  run_device: 'Connected your app on a device or emulator',
  upload_bundle: 'Uploaded an update',
  test_update: 'Completed the update checklist',
  start_setup: 'Started your native build setup',
  choose_destination: 'Chose your iOS build destination',
  connect_app_store: 'Connected App Store Connect',
  prepare_certificate: 'Prepared your iOS signing certificate',
  prepare_profile: 'Prepared your iOS provisioning profile',
  prepare_keystore: 'Prepared your Android keystore',
  connect_google_play: 'Connected Google Play',
  successful_cloud_build: 'Completed the cloud build checklist',
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function timestamp(value: unknown, minimum = Number.NEGATIVE_INFINITY): string | null {
  if (typeof value !== 'string' || !value.trim())
    return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && milliseconds >= minimum ? new Date(milliseconds).toISOString() : null
}

function status(value: unknown): TaskStatus {
  return value === 'done' || value === 'pending' || value === 'skipped' || value === 'warning' ? value : 'unknown'
}

export function buildAppEvidence(row: LifecycleAppRow, product: Product, verified: VerifiedAppOutcomes = {}): AppEvidence | null {
  const createdAt = timestamp(row.created_at)
  if (!createdAt || !row.id?.trim() || !row.app_id?.trim())
    return null

  const setup = record(record(row.onboarding).setup)
  const paths = Array.isArray(setup.paths) ? setup.paths : []
  const supported = product === 'ota'
    ? setup.todo_list_version === 3 || (setup.todo_list_version === 4 && setup.ota_todo_list_version === '1' && paths.includes('ota'))
    : setup.todo_list_version === 4 && setup.builder_todo_list_version === '1' && paths.includes('builder')
  if (!supported)
    return null

  const platform = product === 'builder' && (setup.selected_builder_platform === 'ios' || setup.selected_builder_platform === 'android')
    ? setup.selected_builder_platform
    : null
  const platformNotChosen = product === 'builder' && setup.selected_builder_platform == null
  const stepPaths = record(setup.steps)
  const rawSteps = product === 'ota'
    ? setup.todo_list_version === 3 ? stepPaths : record(stepPaths.ota)
    : platform ? record(record(stepPaths.builder)[platform]) : {}
  const stepIds: readonly string[] = product === 'ota' ? APP_ONBOARDING_OTA_V1_STEP_IDS : platform ? BUILDER_STEPS[platform] : []
  const createdMs = Date.parse(createdAt)
  const tasks = Object.fromEntries(stepIds.map((step) => {
    const raw = record(rawSteps[step])
    const taskStatus = status(raw.status)
    // Explicitly stale completion dates cannot configure a new incarnation.
    const staleCompletion = taskStatus === 'done' && raw.at !== undefined && !timestamp(raw.at, createdMs)
    return [step, staleCompletion ? 'unknown' : taskStatus]
  })) as Record<string, TaskStatus>
  const scope = `${row.id}:${product}:${platform ?? 'ota'}`
  const facts: Fact[] = []
  for (const step of stepIds) {
    const raw = record(rawSteps[step])
    const at = timestamp(raw.at, createdMs)
    if (tasks[step] !== 'done' || !at)
      continue
    facts.push({
      // Stable identities let callers distinguish observing a historical fact
      // from a genuinely new completion, without treating reselection as work.
      id: `${scope}:task:${step}`,
      at,
      step,
      kind: 'task',
      acknowledgement: step === 'add_code' && raw.annotation === APP_ONBOARDING_ADD_CODE_INFERRED_ANNOTATION
        ? 'Confirmed the updater integration'
        : ACKNOWLEDGEMENTS[step]!,
    })
  }

  const valueAt = timestamp(product === 'ota' ? verified.otaAppliedAt : verified.builderSucceededAt, createdMs)
  const valueId = product === 'ota' ? verified.otaBundleId : verified.builderJobId
  // Real native builds can coexist with the OTA demo splash. Builder callers
  // must exclude tracked demo request rows before supplying a verified result.
  const isDemoValue = verified.demoApp === true
    || (product === 'ota' && row.need_onboarding && verified.demoApp !== false)
    || (product === 'builder' && valueId?.startsWith('demo-job-'))
  const firstValue: Fact | null = !isDemoValue && (product === 'ota' || platform !== null) && valueAt && typeof valueId === 'string' && valueId.trim()
    ? {
        id: `${scope}:value:${valueId}`,
        at: valueAt,
        step: product === 'ota' ? 'test_update' : 'successful_cloud_build',
        kind: 'value',
        acknowledgement: product === 'ota' ? 'Applied an update on a device ✨' : `Completed a successful ${platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'native'} cloud build ✨`,
      }
    : null
  if (firstValue)
    facts.push(firstValue)

  return {
    appId: row.app_id,
    incarnation: row.id,
    createdAt,
    name: row.name ?? '',
    product,
    platform,
    selected: setup.todo_list_version === 3 || setup.selected_path === product || (paths.length === 1 && paths[0] === product),
    // An omitted/null platform is the valid first Builder task. An invalid
    // platform or unknown platform-specific checklist remains unhealthy.
    healthy: platformNotChosen || (stepIds.length > 0 && Object.values(tasks).every(value => value !== 'unknown')),
    activeUntil: timestamp(verified.runningUntil, createdMs),
    facts,
    tasks,
    // Canonical console completion counts intentional skips, while skips do
    // not become achievements or independently verified real value.
    checklistComplete: stepIds.length > 0 && stepIds.every(step => tasks[step] === 'done' || tasks[step] === 'skipped'),
    firstValue,
    // Current funding allowance is independent of app checklist/signing state.
    // This adapter has no authoritative funding input and must not invent it.
    fundingBlocked: false,
  }
}

export interface NextTask {
  id: string
  title: string
  explanation: string
  ctaLabel: string
}

const TASK_HELP: Record<string, Omit<NextTask, 'id'>> = {
  login_cli_mcp: { title: 'Connect the Capgo CLI or MCP', explanation: 'Connect your local project so you can continue setup with the CLI or your AI assistant.', ctaLabel: 'Connect my project' },
  add_channel: { title: 'Create your channel', explanation: 'Choose the channel your app will use to receive updates.', ctaLabel: 'Create my channel' },
  add_updater: { title: 'Install Capacitor Updater', explanation: 'Install Capacitor Updater in your project to let your app receive updates.', ctaLabel: 'Install the updater' },
  add_code: { title: 'Finish your updater integration', explanation: 'Follow the setup checklist to connect the updater to your app. You can also continue with the AI setup prompt in the console.', ctaLabel: 'Continue my setup' },
  run_device: { title: 'Run your app', explanation: 'Run your app on a device or an emulator so it can connect to Capgo.', ctaLabel: 'Run my app' },
  upload_bundle: { title: 'Upload your first update', explanation: 'Upload your app bundle and make it available on the channel your app uses.', ctaLabel: 'Upload my update' },
  test_update: { title: 'Test your update', explanation: 'Run your app, check that the channel points to your uploaded bundle, then check the download and install result. If it has not applied yet, reply and we will help you check it.', ctaLabel: 'Test my update' },
  start_setup: { title: 'Start your native build setup', explanation: 'Open the build checklist to prepare your project for a cloud build.', ctaLabel: 'Start my build setup' },
  choose_destination: { title: 'Choose your iOS build destination', explanation: 'Choose the distribution destination that fits the build you want to make.', ctaLabel: 'Choose my destination' },
  connect_app_store: { title: 'Connect App Store Connect', explanation: 'Continue in the setup checklist to connect and verify App Store Connect.', ctaLabel: 'Connect App Store Connect' },
  prepare_certificate: { title: 'Prepare your iOS certificate', explanation: 'Continue in the setup checklist to prepare the signing certificate for your iOS build.', ctaLabel: 'Prepare my certificate' },
  prepare_profile: { title: 'Prepare your iOS profile', explanation: 'Continue in the setup checklist to prepare the provisioning profile for your build destination.', ctaLabel: 'Prepare my profile' },
  prepare_keystore: { title: 'Prepare your Android keystore', explanation: 'Continue in the setup checklist to prepare the keystore for your Android build.', ctaLabel: 'Prepare my keystore' },
  connect_google_play: { title: 'Connect Google Play', explanation: 'Continue in the setup checklist to connect Google Play for your Android build.', ctaLabel: 'Connect Google Play' },
  successful_cloud_build: { title: 'Run your cloud build', explanation: 'Start your cloud build and check its result. If it needs attention, reply and we will help you check the next step.', ctaLabel: 'Run my cloud build' },
}

export function nextTask(evidence: AppEvidence): NextTask | null {
  if (evidence.product === 'builder' && evidence.platform === null) {
    return { id: 'select_builder_platform', title: 'Choose your build platform', explanation: 'Choose iOS or Android in the build checklist so we can guide your next step.', ctaLabel: 'Choose my platform' }
  }
  // Missing evidence is not an unfinished task. Skips remain intentional skips.
  const id = Object.keys(evidence.tasks).find(step => evidence.tasks[step] === 'pending' || evidence.tasks[step] === 'warning')
  return id && TASK_HELP[id] ? { id, ...TASK_HELP[id] } : null
}
