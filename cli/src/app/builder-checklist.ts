import type { AgentTrial } from '../shared/agent-notices'
import { formatAgentTodoTrialItem } from '../shared/agent-notices'

export const BUILDER_STEP_IDS = {
  ios: ['start_setup', 'choose_destination', 'connect_app_store', 'prepare_certificate', 'prepare_profile', 'successful_cloud_build'],
  android: ['start_setup', 'prepare_keystore', 'connect_google_play', 'successful_cloud_build'],
} as const

export type BuilderChecklistPlatform = keyof typeof BUILDER_STEP_IDS
export type BuilderChecklistStatus = 'pending' | 'done' | 'skipped' | 'warning'

const TITLES: Record<string, string> = {
  start_setup: 'Start guided Builder setup',
  choose_destination: 'Choose where the build goes',
  connect_app_store: 'Connect App Store Connect',
  prepare_certificate: 'Prepare a distribution certificate',
  prepare_profile: 'Prepare a provisioning profile',
  prepare_keystore: 'Prepare your signing keystore',
  connect_google_play: 'Connect Google Play',
  successful_cloud_build: 'Run a successful cloud build',
}

const ANNOTATIONS: Record<string, string> = {
  asc_new: 'You chose guided setup for TestFlight. The CLI will help prepare your Apple signing credentials (certificate and provisioning profile).',
  asc_new_auto: 'Guided setup for TestFlight was selected automatically because importing signing credentials requires macOS.',
  import_app_store: 'You chose to use existing signing credentials for an App Store or TestFlight build.',
  import_ad_hoc: 'You chose Ad Hoc distribution: install directly on registered devices without TestFlight, using your existing signing credentials.',
  asc_key_verification_failed: 'Capgo could not verify your App Store Connect API key. Resume setup and check the key, key ID, and issuer ID.',
  ios_certificate_creation_failed: 'Apple could not create a signing certificate. Resume setup to review the error and retry.',
  ios_certificate_limit_reached: 'Your Apple account has reached its certificate limit. Resume setup to reuse an existing certificate or choose one to revoke.',
  ios_certificate_export_failed: 'The CLI could not export the signing certificate from your Mac. Resume setup and check that the certificate has its private key in Keychain.',
  certificate_preparation_failed: 'Signing certificate setup failed. Resume setup to review the error and retry.',
  cloud_build_failed: 'Cloud build failed. Open the build logs to see the error, fix it, then retry the build.',
}

export function onboardingRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function getBuilderOnlySetup(value: unknown): Record<string, unknown> | null {
  const raw = onboardingRecord(value)
  const setup = Object.hasOwn(raw, 'setup') ? onboardingRecord(raw.setup) : raw
  const steps = onboardingRecord(setup.steps)
  const builder = onboardingRecord(steps.builder)
  if (setup.todo_list_version !== 4
    || setup.builder_todo_list_version !== '1'
    || !Array.isArray(setup.paths) || setup.paths.length !== 1 || setup.paths[0] !== 'builder'
    || setup.selected_path !== 'builder'
    || Object.hasOwn(setup, 'ota_todo_list_version') || Object.hasOwn(steps, 'ota')
    || !builder.ios || Array.isArray(builder.ios) || typeof builder.ios !== 'object'
    || !builder.android || Array.isArray(builder.android) || typeof builder.android !== 'object') {
    return null
  }
  return setup
}

export function getBuilderOnlyChecklist(value: unknown) {
  const setup = getBuilderOnlySetup(value)
  if (!setup)
    return null
  return parseBuilderChecklist(setup)
}

export function getBuilderChecklist(value: unknown) {
  const raw = onboardingRecord(value)
  const setup = Object.hasOwn(raw, 'setup') ? onboardingRecord(raw.setup) : raw
  if (setup.todo_list_version !== 4 || setup.builder_todo_list_version !== '1'
    || !Array.isArray(setup.paths) || !setup.paths.includes('builder')) {
    return null
  }
  return parseBuilderChecklist(setup)
}

function parseBuilderChecklist(setup: Record<string, unknown>) {
  const selectedPlatform: BuilderChecklistPlatform | undefined = setup.selected_builder_platform === 'ios' || setup.selected_builder_platform === 'android'
    ? setup.selected_builder_platform : undefined
  const builder = onboardingRecord(onboardingRecord(setup.steps).builder)
  const steps = (['ios', 'android'] as const).flatMap(platform => BUILDER_STEP_IDS[platform].map((stepId) => {
    const step = onboardingRecord(onboardingRecord(builder[platform])[stepId])
    const status: BuilderChecklistStatus = step.status === 'done' || step.status === 'skipped' || step.status === 'warning' ? step.status : 'pending'
    return {
      id: `builder.${platform}.${stepId}`,
      stepId,
      platform,
      title: TITLES[stepId],
      status,
      at: typeof step.at === 'string' ? step.at : undefined,
      annotation: typeof step.annotation === 'string' ? step.annotation : undefined,
      annotationType: typeof step.annotation_type === 'string' ? step.annotation_type : undefined,
    }
  }))
  return { version: 4, path: 'builder' as const, selectedPlatform, steps }
}

export function formatBuilderOnlyChecklist(appId: string, checklist: NonNullable<ReturnType<typeof getBuilderOnlyChecklist>>, options: { color?: boolean, trial?: AgentTrial } = {}): string {
  const colorize = (value: string, code: string) => options.color ? `\u001B[${code}m${value}\u001B[0m` : value
  const lines = [colorize(`App: ${appId} — Todo list v4 — Builder checklist`, '1')]
  const done = checklist.steps.filter(step => step.status === 'done').length
  const skipped = checklist.steps.filter(step => step.status === 'skipped').length
  lines.push(`${done + skipped}/${checklist.steps.length} completed (${done} done, ${skipped} skipped, ${checklist.steps.length - done - skipped} remaining)`)
  const markers = { done: '[x] Done', skipped: '[-] Skipped', pending: '[ ] Pending', warning: '[!] Warning' }
  const colors = { done: '32', skipped: '2', pending: '33', warning: '31' }
  for (const platform of ['ios', 'android'] as const) {
    lines.push('', colorize(`${platform === 'ios' ? '🍎 iOS' : '🤖 Android'}${checklist.selectedPlatform === platform ? ' (selected)' : ''}`, '1;36'))
    for (const step of checklist.steps.filter(step => step.platform === platform)) {
      lines.push(`${colorize(markers[step.status], colors[step.status])}: ${step.title}${step.at ? colorize(` (${step.at})`, '2') : ''}`)
      const warning = step.annotationType === 'warning'
      const annotation = (step.annotation ? ANNOTATIONS[step.annotation] : undefined)
        ?? (warning ? 'Resume guided setup to see what needs fixing, then retry this step.' : undefined)
      if (annotation) {
        const label = warning ? 'Warning: ' : 'Note: '
        for (const [index, sentence] of annotation.split(/(?<=[.!?])\s+/).entries()) {
          const prefix = index === 0 ? label : ' '.repeat(label.length)
          lines.push(`  ${colorize(`${prefix}${sentence}`, warning ? '31' : '36')}`)
        }
      }
    }
  }
  const openSteps = checklist.steps.filter(step => step.status === 'pending' || step.status === 'warning')
  const next = checklist.selectedPlatform
    ? openSteps.find(step => step.platform === checklist.selectedPlatform) ?? openSteps[0]
    : undefined
  if (options.trial)
    lines.push('', formatAgentTodoTrialItem(options.trial, true))
  lines.push('')
  if (!openSteps.length)
    lines.push('Both platform checklists are complete.')
  else if (!next)
    lines.push('Choose a platform to start or resume Builder setup.')
  else {
    if (next.platform !== checklist.selectedPlatform)
      lines.push(`Continue with ${next.platform === 'ios' ? '🍎 iOS' : '🤖 Android'} to finish the remaining tasks.`)
    lines.push(colorize(`Next step: ${next.title}`, '1;36'))
  }
  lines.push(`Run from your Capacitor app folder: ${colorize(`npx @capgo/cli@latest build init${next ? ` --platform ${next.platform}` : ''}`, '36')}`)
  lines.push('The checklist finishes when Capgo reports a successful cloud build for that platform.', 'Run this command again to recheck progress.')
  return lines.join('\n')
}
