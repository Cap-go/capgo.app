import { initOnboardingSteps } from './onboarding-steps'
import { clearInitLogs, setInitScreen, setInitSpinner } from './runtime'

export { initOnboardingSteps }

type PanelTone = 'cyan' | 'blue' | 'green' | 'yellow'

function phaseTone(phase: string): PanelTone {
  switch (phase) {
    case 'Prepare':
      return 'blue'
    case 'Integrate':
      return 'cyan'
    case 'Validate':
      return 'green'
    case 'Finish':
      return 'yellow'
    default:
      return 'cyan'
  }
}

function progressPercent(stepNumber: number, totalSteps: number) {
  return Math.round(((stepNumber - 1) / totalSteps) * 100)
}

export function renderInitOnboardingWelcome(totalSteps: number, analyticsEnabled = true): void {
  clearInitLogs()
  setInitScreen({
    title: 'Capgo OTA Onboarding',
    introLines: [
      `Connect your Capacitor app to Capgo in ${totalSteps} guided steps.`,
      'Guide · https://capgo.app/docs/getting-started/onboarding/',
      'Session · ETA 2-10 min • Resume support automatic',
      ...(analyticsEnabled ? ['Analytics: this onboarding records usage and terminal replay to improve Capgo. Opt out with --no-analytics.'] : []),
    ],
    tone: 'cyan',
  })
}

export function renderInitOnboardingFrame(currentStepNumber: number, totalSteps: number, options?: { resumed?: boolean }): void {
  clearInitLogs()
  setInitSpinner()
  const step = initOnboardingSteps[currentStepNumber - 1]
  const nextStep = initOnboardingSteps[currentStepNumber]
  if (!step) {
    setInitScreen({
      title: 'Capgo OTA Onboarding',
      stepLabel: 'Current Step',
      stepSummary: 'Waiting for onboarding step data.',
      tone: 'cyan',
    })
    return
  }

  const completedPercent = progressPercent(currentStepNumber, totalSteps)
  const completedSteps = Math.max(0, currentStepNumber - 1)
  const remainingSteps = Math.max(0, totalSteps - completedSteps)
  const nextLabel = nextStep ? nextStep.title : 'Finish onboarding'

  setInitScreen({
    phaseLabel: step.phase,
    progress: completedPercent,
    stepLabel: `Step ${currentStepNumber}/${totalSteps} · ${step.title}`,
    stepSummary: step.summary,
    roadmapLine: `Next · ${nextLabel}`,
    statusLine: `Progress · ${completedSteps}/${totalSteps} done • ${remainingSteps} left`,
    resumeLine: options?.resumed ? `Continuing from step ${currentStepNumber}/${totalSteps}` : undefined,
    tone: phaseTone(step.phase),
  })
}

export function renderInitOnboardingComplete(appId: string, nextUploadCommand: string, debugCommand: string): void {
  clearInitLogs()
  setInitScreen({
    title: 'Onboarding Complete',
    completionLines: [
      `${appId} is now wired for Capgo OTA updates.`,
      'Self-test on your device: make a visible change, run a web build only, then upload.',
      'Background the app and reopen it to fetch the update. Do not run cap sync for this test.',
      `Next upload · ${nextUploadCommand}`,
      `Debug · ${debugCommand}`,
    ],
    tone: 'green',
  })
}

export function formatInitResumeMessage(stepDone: number, totalSteps: number): string {
  const safeStepDone = Math.min(Math.max(stepDone, 0), totalSteps)
  const nextStep = initOnboardingSteps[safeStepDone]
  const label = nextStep ? ` · next: ${nextStep.title}` : ''
  return `Resume point detected: ${safeStepDone}/${totalSteps}${label}`
}
