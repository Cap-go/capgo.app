export interface OnboardingPlanStop {
  value: number
  label: string
  planName: string
  startingOut?: boolean
}

const ONBOARDING_PLAN_NAME_ORDER = ['Solo', 'Maker', 'Team', 'Enterprise'] as const

const FALLBACK_PLAN_STOPS: OnboardingPlanStop[] = [
  { value: 2000, label: '2K', planName: 'Solo' },
  { value: 10000, label: '10K', planName: 'Maker' },
  { value: 100000, label: '100K', planName: 'Team' },
  { value: 1000000, label: '1M+', planName: 'Enterprise' },
]

const STARTING_OUT_PLAN_STOP: OnboardingPlanStop = {
  value: 0,
  label: '0',
  planName: 'Solo',
  startingOut: true,
}

function formatOnboardingUserCount(value: number, plus = false) {
  if (value >= 1_000_000)
    return plus ? '1M+' : '1M'
  if (value >= 1000)
    return `${value / 1000}K`
  return String(value)
}

/**
 * Monthly-active-user tiers offered in onboarding. The chosen `value` is sent as
 * `estimatedMau` to `POST /organization`, which picks the org's initial trial plan from it.
 * Used by both the manual wizard and AI onboarding.
 */
export function onboardingPlanStops(plans: Array<{ name: string, mau: number | string | null }>): OnboardingPlanStop[] {
  const planStops = ONBOARDING_PLAN_NAME_ORDER.map(planName => plans.find(plan => plan.name === planName)).flatMap((plan) => {
    if (!plan?.mau)
      return []
    const mau = Number(plan.mau)
    if (!Number.isFinite(mau) || mau <= 0)
      return []
    return [{ value: mau, label: formatOnboardingUserCount(mau, plan.name === 'Enterprise'), planName: plan.name }]
  })
  return [
    STARTING_OUT_PLAN_STOP,
    ...(planStops.length === ONBOARDING_PLAN_NAME_ORDER.length ? planStops : FALLBACK_PLAN_STOPS),
  ]
}
