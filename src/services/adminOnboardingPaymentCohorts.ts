import { getFormatLocale } from '~/services/formatLocale'

export interface OnboardingPaymentConversion {
  paid: number
  eligible: number
  conversion_percent: number | null
}

export interface OnboardingPaymentCohortRow {
  month: string
  signups: number
  excluded_no_public_row: number
  excluded_invite: number
  days_3: OnboardingPaymentConversion
  days_7: OnboardingPaymentConversion
  days_14: OnboardingPaymentConversion
  ever: OnboardingPaymentConversion
}

export interface OnboardingPaymentCohortReport {
  start: string
  cutoff: string
  rows: OnboardingPaymentCohortRow[]
  credit_timestamp_fallbacks: number
  invoice_last_synced_at: string | null
  invoice_sync_type: string | null
}

export function getOnboardingPaymentCohortPeriod(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString(),
    cutoff: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString(),
  }
}

function invalidReport(): never {
  throw new Error('Malformed or stale onboarding payment cohort report')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidReport()
  return value as Record<string, unknown>
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalidReport()
  return value
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value))
    return invalidReport()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19))
    return invalidReport()
  return parsed.toISOString()
}

function conversion(value: unknown, signups: number): OnboardingPaymentConversion {
  const cell = record(value)
  const paid = count(cell.paid)
  const eligible = count(cell.eligible)
  if (paid > eligible || eligible > signups)
    return invalidReport()
  const percentage = cell.conversion_percent
  if (eligible === 0) {
    if (percentage !== null)
      return invalidReport()
  }
  else if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100 || Math.abs(percentage - paid / eligible * 100) > 1e-8) {
    return invalidReport()
  }
  return { paid, eligible, conversion_percent: percentage as number | null }
}

export function validateOnboardingPaymentCohortReport(value: unknown, now = new Date()): OnboardingPaymentCohortReport {
  const report = record(value)
  if (typeof report.start !== 'string' || typeof report.cutoff !== 'string' || !/T00:00:00(?:\.0+)?Z$/.test(report.start) || !/T00:00:00(?:\.0+)?Z$/.test(report.cutoff))
    return invalidReport()
  const start = timestamp(report.start)
  const cutoff = timestamp(report.cutoff)
  const expected = getOnboardingPaymentCohortPeriod(now)
  if (start !== expected.start || cutoff !== expected.cutoff || !Array.isArray(report.rows) || report.rows.length !== 4)
    return invalidReport()
  const cutoffDate = new Date(cutoff)
  const rows = report.rows.map((value, index): OnboardingPaymentCohortRow => {
    const row = record(value)
    const month = new Date(Date.UTC(cutoffDate.getUTCFullYear(), cutoffDate.getUTCMonth() - index, 1)).toISOString().slice(0, 10)
    if (row.month !== month)
      return invalidReport()
    const signups = count(row.signups)
    return {
      month,
      signups,
      excluded_no_public_row: count(row.excluded_no_public_row),
      excluded_invite: count(row.excluded_invite),
      days_3: conversion(row.days_3, signups),
      days_7: conversion(row.days_7, signups),
      days_14: conversion(row.days_14, signups),
      ever: conversion(row.ever, signups),
    }
  })
  const syncType = report.invoice_sync_type
  if (syncType !== null && (typeof syncType !== 'string' || !syncType.trim() || syncType.length > 512 || [...syncType].some(char => char.charCodeAt(0) < 32)))
    return invalidReport()
  return {
    start,
    cutoff,
    rows,
    credit_timestamp_fallbacks: count(report.credit_timestamp_fallbacks),
    invoice_last_synced_at: report.invoice_last_synced_at === null ? null : timestamp(report.invoice_last_synced_at),
    invoice_sync_type: syncType as string | null,
  }
}

export function formatOnboardingPaymentCohortMonth(month: string): string {
  return new Intl.DateTimeFormat(getFormatLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}T00:00:00Z`))
}

export function formatOnboardingPaymentCohortTimestamp(value: string): string {
  return new Intl.DateTimeFormat(getFormatLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))
}

interface PaymentCohortLoaderHandlers {
  onReport: (report: OnboardingPaymentCohortReport | null) => void
  onLoading: (loading: boolean) => void
  onError: (error: unknown | null) => void
}

export function createOnboardingPaymentCohortLoader(
  fetchReport: (forceRefresh: boolean) => Promise<unknown>,
  handlers: PaymentCohortLoaderHandlers,
  getAuthIdentity: () => string | null,
) {
  let request = 0
  let disposed = false

  function invalidate() {
    request++
    if (disposed)
      return
    handlers.onReport(null)
    handlers.onError(null)
    handlers.onLoading(false)
  }

  async function load(forceRefresh = false): Promise<void> {
    const identity = getAuthIdentity()
    if (disposed || identity === null)
      return
    const currentRequest = ++request
    const isCurrent = () => !disposed && currentRequest === request && identity === getAuthIdentity()
    handlers.onReport(null)
    handlers.onError(null)
    handlers.onLoading(true)
    try {
      const value = await fetchReport(forceRefresh)
      if (!isCurrent())
        return
      handlers.onReport(validateOnboardingPaymentCohortReport(value))
    }
    catch (error) {
      if (isCurrent())
        handlers.onError(error)
    }
    finally {
      if (isCurrent())
        handlers.onLoading(false)
    }
  }

  function dispose() {
    disposed = true
    request++
  }

  return { load, invalidate, dispose }
}
