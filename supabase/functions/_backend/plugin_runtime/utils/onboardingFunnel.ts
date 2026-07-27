import type { AdminOnboardingTelemetry } from './cloudflare.ts'

export interface AdminOnboardingActivationCohort {
  org_id: string
  app_id: string
  created_at: Date | string
  activation_window_end: Date | string
}

export interface AdminOnboardingActivationMetrics {
  orgs_with_production_device: number
  orgs_with_update_download: number
  trend_by_date: Map<string, {
    orgs_with_production_device: number
    orgs_with_update_download: number
  }>
}

function toValidDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isWithinActivationWindow(eventAt: Date | undefined, startAt: Date, endAt: Date) {
  return Boolean(eventAt && eventAt >= startAt && eventAt < endAt)
}

export function getAdminOnboardingActivationMetrics(
  cohorts: AdminOnboardingActivationCohort[],
  telemetry: AdminOnboardingTelemetry,
): AdminOnboardingActivationMetrics {
  if (!telemetry.available) {
    return {
      orgs_with_production_device: 0,
      orgs_with_update_download: 0,
      trend_by_date: new Map(),
    }
  }

  const productionDeviceOrgIds = new Set<string>()
  const updateDownloadOrgIds = new Set<string>()
  const productionDeviceOrgIdsByDate = new Map<string, Set<string>>()
  const updateDownloadOrgIdsByDate = new Map<string, Set<string>>()

  for (const cohort of cohorts) {
    const startAt = toValidDate(cohort.created_at)
    const endAt = toValidDate(cohort.activation_window_end)
    if (!startAt || !endAt || startAt >= endAt)
      continue

    const date = startAt.toISOString().slice(0, 10)
    const productionDeviceAt = telemetry.first_production_device_at_by_app.get(cohort.app_id)
    if (!isWithinActivationWindow(productionDeviceAt, startAt, endAt))
      continue

    productionDeviceOrgIds.add(cohort.org_id)
    const productionDeviceOrgIdsForDate = productionDeviceOrgIdsByDate.get(date) ?? new Set<string>()
    productionDeviceOrgIdsForDate.add(cohort.org_id)
    productionDeviceOrgIdsByDate.set(date, productionDeviceOrgIdsForDate)

    const updateDownloadAt = telemetry.first_update_download_at_by_app.get(cohort.app_id)
    if (isWithinActivationWindow(updateDownloadAt, startAt, endAt)) {
      updateDownloadOrgIds.add(cohort.org_id)
      const updateDownloadOrgIdsForDate = updateDownloadOrgIdsByDate.get(date) ?? new Set<string>()
      updateDownloadOrgIdsForDate.add(cohort.org_id)
      updateDownloadOrgIdsByDate.set(date, updateDownloadOrgIdsForDate)
    }
  }

  const trendByDate = new Map<string, {
    orgs_with_production_device: number
    orgs_with_update_download: number
  }>()
  for (const date of new Set([...productionDeviceOrgIdsByDate.keys(), ...updateDownloadOrgIdsByDate.keys()])) {
    trendByDate.set(date, {
      orgs_with_production_device: productionDeviceOrgIdsByDate.get(date)?.size ?? 0,
      orgs_with_update_download: updateDownloadOrgIdsByDate.get(date)?.size ?? 0,
    })
  }

  return {
    orgs_with_production_device: productionDeviceOrgIds.size,
    orgs_with_update_download: updateDownloadOrgIds.size,
    trend_by_date: trendByDate,
  }
}
