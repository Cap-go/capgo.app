import type { AppEvidence, Fact, Product } from './evidence.ts'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
export interface Batch {
  key: string
  incarnation: string
  openedAt: string
  lastAt: string
  facts: Fact[]
}
export interface JourneyState {
  enrolledAt: string
  lastProgressAt: string
  appLessSince: string | null
  checklistCompleteAt: string | null
  firstValueAt: string | null
  batch: Batch | null
}
export interface AcceptedPurpose {
  purpose: string
  acceptedAt: string
  context: string
  product: Product
}
export interface PlanRecommendation {
  name: string
  monthlyPrice: number
  reason: string
  includes: string
}
export interface LifecycleInput {
  now: string
  orgId: string
  orgName: string
  product: Product
  recipientId: string
  email: string
  creatorTreatment: boolean
  consent: boolean
  selected: boolean
  shippingIntent: boolean
  supportHold: boolean
  paused: boolean
  evidence: AppEvidence | null
  sourceHealthy: boolean
  state: JourneyState
  accepted: AcceptedPurpose[]
  trialDeadline: string | null
  billingHealthy: boolean
  paid: boolean
  compatibleCredits: boolean
  plan: PlanRecommendation | null
}
export interface Candidate {
  branch: string
  purpose: string
  context: string
  priority: number
  expiresAt: string
  /** Server-only dispatch metadata. Never included in the Bento event payload. */
  commercialOffer?: boolean
}
export const ms = (value: string | null | undefined) => value ? Date.parse(value) : Number.NaN
export const iso = (value: number) => new Date(value).toISOString()
export function accepted(input: LifecycleInput, purpose: string) {
  return input.accepted.find(item => item.purpose === purpose)
}
export function reminderContext(input: LifecycleInput) {
  const app = input.evidence
  const pending = app ? Object.entries(app.tasks).filter(([, status]) => status === 'pending' || status === 'warning').map(([key]) => key).join(',') : 'no-app'
  return `${input.product}:${app?.incarnation ?? 'no-app'}:${app?.platform ?? ''}:${input.state.lastProgressAt}:${app ? '' : input.state.appLessSince ?? ''}:${pending}`
}
