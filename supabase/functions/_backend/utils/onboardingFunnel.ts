import type { AdminOnboardingTelemetry } from './cloudflare.ts'

export interface AdminOnboardingActivationCohort {
  org_id: string
  app_id: string
  created_at: Date | string
  activation_window_end: Date | string
}

export const ADMIN_ONBOARDING_WIZARD_BUCKETS = [
  'not_started',
  'intent',
  'details',
  'organization',
  'choice',
  'install',
  'setup',
  'completed',
  'abandoned',
] as const

export type AdminOnboardingWizardBucket = typeof ADMIN_ONBOARDING_WIZARD_BUCKETS[number]

export interface AdminOnboardingWizardDropoff {
  step: AdminOnboardingWizardBucket
  count: number
}

export function buildAdminOnboardingWizardDropoff(
  rows: Array<{ step?: unknown, count?: unknown }>,
): AdminOnboardingWizardDropoff[] {
  const counts = Object.fromEntries(
    ADMIN_ONBOARDING_WIZARD_BUCKETS.map(step => [step, 0]),
  ) as Record<AdminOnboardingWizardBucket, number>

  for (const row of rows) {
    const count = Number(row.count) || 0
    if (!count)
      continue
    const step = typeof row.step === 'string' && (ADMIN_ONBOARDING_WIZARD_BUCKETS as readonly string[]).includes(row.step)
      ? row.step as AdminOnboardingWizardBucket
      : 'not_started'
    counts[step] += count
  }

  return ADMIN_ONBOARDING_WIZARD_BUCKETS.map(step => ({
    step,
    count: counts[step],
  }))
}

export interface AdminOnboardingActivationTrendPoint {
  orgs_with_production_device: number
  orgs_with_update_download: number
  orgs_with_testflight: number
  orgs_with_store_live: number
}

export interface AdminOnboardingActivationMetrics {
  orgs_with_production_device: number
  orgs_with_update_download: number
  orgs_with_testflight: number
  orgs_with_store_live: number
  trend_by_date: Map<string, AdminOnboardingActivationTrendPoint>
}

function toValidDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isWithinActivationWindow(eventAt: Date | undefined, startAt: Date, endAt: Date) {
  return Boolean(eventAt && eventAt >= startAt && eventAt < endAt)
}

function addOrgToDateSet(
  orgIds: Set<string>,
  orgIdsByDate: Map<string, Set<string>>,
  orgId: string,
  date: string,
) {
  orgIds.add(orgId)
  const orgIdsForDate = orgIdsByDate.get(date) ?? new Set<string>()
  orgIdsForDate.add(orgId)
  orgIdsByDate.set(date, orgIdsForDate)
}

function emptyActivationMetrics(): AdminOnboardingActivationMetrics {
  return {
    orgs_with_production_device: 0,
    orgs_with_update_download: 0,
    orgs_with_testflight: 0,
    orgs_with_store_live: 0,
    trend_by_date: new Map(),
  }
}

export function getAdminOnboardingActivationMetrics(
  cohorts: AdminOnboardingActivationCohort[],
  telemetry: AdminOnboardingTelemetry,
): AdminOnboardingActivationMetrics {
  if (!telemetry.available)
    return emptyActivationMetrics()

  const productionDeviceOrgIds = new Set<string>()
  const updateDownloadOrgIds = new Set<string>()
  const storeLiveOrgIds = new Set<string>()
  const testflightOrgIds = new Set<string>()
  const productionDeviceOrgIdsByDate = new Map<string, Set<string>>()
  const updateDownloadOrgIdsByDate = new Map<string, Set<string>>()
  const storeLiveOrgIdsByDate = new Map<string, Set<string>>()
  const testflightOrgIdsByDate = new Map<string, Set<string>>()

  for (const cohort of cohorts) {
    const startAt = toValidDate(cohort.created_at)
    const endAt = toValidDate(cohort.activation_window_end)
    if (!startAt || !endAt || startAt >= endAt)
      continue

    const date = startAt.toISOString().slice(0, 10)
    const storeLiveAt = telemetry.first_store_live_at_by_app.get(cohort.app_id)
    if (isWithinActivationWindow(storeLiveAt, startAt, endAt))
      addOrgToDateSet(storeLiveOrgIds, storeLiveOrgIdsByDate, cohort.org_id, date)

    const testflightAt = telemetry.first_testflight_at_by_app.get(cohort.app_id)
    if (isWithinActivationWindow(testflightAt, startAt, endAt))
      addOrgToDateSet(testflightOrgIds, testflightOrgIdsByDate, cohort.org_id, date)

    const productionDeviceAt = telemetry.first_production_device_at_by_app.get(cohort.app_id)
    if (!isWithinActivationWindow(productionDeviceAt, startAt, endAt))
      continue

    addOrgToDateSet(productionDeviceOrgIds, productionDeviceOrgIdsByDate, cohort.org_id, date)

    const updateDownloadAt = telemetry.first_update_download_at_by_app.get(cohort.app_id)
    if (isWithinActivationWindow(updateDownloadAt, startAt, endAt))
      addOrgToDateSet(updateDownloadOrgIds, updateDownloadOrgIdsByDate, cohort.org_id, date)
  }

  for (const orgId of storeLiveOrgIds) {
    testflightOrgIds.delete(orgId)
    for (const orgs of testflightOrgIdsByDate.values())
      orgs.delete(orgId)
  }

  const trendByDate = new Map<string, AdminOnboardingActivationTrendPoint>()
  const dates = new Set([
    ...productionDeviceOrgIdsByDate.keys(),
    ...updateDownloadOrgIdsByDate.keys(),
    ...storeLiveOrgIdsByDate.keys(),
    ...testflightOrgIdsByDate.keys(),
  ])
  for (const date of dates) {
    trendByDate.set(date, {
      orgs_with_production_device: productionDeviceOrgIdsByDate.get(date)?.size ?? 0,
      orgs_with_update_download: updateDownloadOrgIdsByDate.get(date)?.size ?? 0,
      orgs_with_testflight: testflightOrgIdsByDate.get(date)?.size ?? 0,
      orgs_with_store_live: storeLiveOrgIdsByDate.get(date)?.size ?? 0,
    })
  }

  return {
    orgs_with_production_device: productionDeviceOrgIds.size,
    orgs_with_update_download: updateDownloadOrgIds.size,
    orgs_with_testflight: testflightOrgIds.size,
    orgs_with_store_live: storeLiveOrgIds.size,
    trend_by_date: trendByDate,
  }
}
