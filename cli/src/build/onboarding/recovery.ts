import type { OnboardingStep } from './types.js'
import { formatRunnerCommand } from '../../runner-command.js'

export interface BuildOnboardingRecoveryAdvice {
  summary: string[]
  commands: string[]
  docs: string[]
}

export function getBuildOnboardingRecoveryAdvice(
  message: string,
  step: OnboardingStep | null,
  pmRunner: string,
  appId: string,
): BuildOnboardingRecoveryAdvice {
  const lower = message.toLowerCase()
  const summary: string[] = []
  const commands = new Set<string>()
  const docs = new Set<string>()

  const addIosCommand = formatRunnerCommand(pmRunner, ['cap', 'add', 'ios'])
  const syncIosCommand = formatRunnerCommand(pmRunner, ['cap', 'sync', 'ios'])
  const doctorCommand = formatRunnerCommand(pmRunner, ['@capgo/cli@latest', 'doctor'])
  const buildInitCommand = formatRunnerCommand(pmRunner, ['@capgo/cli@latest', 'build', 'init'])
  const buildRequestCommand = formatRunnerCommand(pmRunner, ['@capgo/cli@latest', 'build', 'request', appId, '--platform', 'ios'])
  const loginCommand = formatRunnerCommand(pmRunner, ['@capgo/cli@latest', 'login'])

  if (step === 'no-platform' || step === 'adding-platform' || lower.includes('no ios/ directory')) {
    summary.push(
      'This project does not have a generated native iOS folder yet.',
      'Create the iOS platform, then sync native sources before resuming onboarding.',
    )
    commands.add(addIosCommand)
    commands.add(syncIosCommand)
  }

  if (lower.includes('required agreement') || lower.includes('agreements, tax, and banking')
    || lower.includes('program license agreement') || lower.includes('pla_not_accepted') || lower.includes('pla update available')) {
    summary.push(
      'Apple is blocking App Store Connect API access because a required agreement is unsigned or has expired.',
      'Your API key is fine — the Account Holder must accept the agreement in App Store Connect, then retry the saved step.',
    )
    docs.add('https://appstoreconnect.apple.com/agreements')
  }
  else if (lower.includes('api key verification failed') || lower.includes('apple rejected the app store connect') || lower.includes('401') || lower.includes('403')) {
    summary.push(
      'Apple rejected the App Store Connect credentials.',
      'Double-check the .p8 file, Key ID, Issuer ID, and that the key still has Admin or Developer access.',
    )
    docs.add('https://capgo.app/docs/cli/cloud-build/ios/')
    docs.add('https://appstoreconnect.apple.com/access/integrations/api')
  }

  if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('etimedout') || lower.includes('enotfound') || lower.includes('econnreset')) {
    summary.push(
      'The CLI could not reach Apple or Capgo over the network.',
      'Check VPN, proxy, firewall, and DNS settings, then retry from the saved step.',
    )
    commands.add(doctorCommand)
  }

  if (lower.includes('429') || lower.includes('rate limit')) {
    summary.push(
      'Apple is rate-limiting the request right now.',
      'Wait a minute, then retry from the saved step instead of restarting the whole flow.',
    )
  }

  if (lower.includes('certificate limit')) {
    summary.push('Apple has reached the maximum number of active distribution certificates for this team.')
  }

  if (lower.includes('duplicate profile')) {
    summary.push(
      'Apple still has conflicting provisioning profiles for this bundle identifier.',
      'You can let onboarding delete the duplicates automatically, or clean them up in App Store Connect and resume.',
    )
    docs.add('https://appstoreconnect.apple.com/access/users')
  }

  if (lower.includes('bundle') && lower.includes('identifier')) {
    summary.push(
      'Apple reported a bundle identifier conflict or bundle registration issue.',
      `Verify that ${appId} is the bundle ID you intend to build for in both Capgo and your Capacitor config.`,
    )
    commands.add(doctorCommand)
  }

  if (lower.includes('file not found') || lower.includes('could not read file') || lower.includes('need .p8 file')) {
    summary.push(
      'The onboarding flow could not read the API key file from disk.',
      'Re-select the .p8 file or move it somewhere stable before retrying.',
    )
  }

  if (lower.includes('no capgo api key found')) {
    summary.push('Capgo login is missing, so the first cloud build cannot be requested automatically.')
    commands.add(loginCommand)
    commands.add(buildRequestCommand)
  }

  if (lower.includes('credentials are saved')) {
    summary.push('Your signing material is already saved locally, so you only need to re-run the build request.')
    commands.add(buildRequestCommand)
  }

  if (summary.length === 0) {
    summary.push(
      'The onboarding flow hit an unexpected error.',
      'Retry the saved step first. If it still fails, capture diagnostics and keep the support bundle when you contact support.',
    )
    commands.add(doctorCommand)
    commands.add(buildInitCommand)
    docs.add('https://capgo.app/docs/cli/cloud-build/ios/')
  }
  else {
    commands.add(buildInitCommand)
  }

  return {
    summary,
    commands: Array.from(commands),
    docs: Array.from(docs),
  }
}
