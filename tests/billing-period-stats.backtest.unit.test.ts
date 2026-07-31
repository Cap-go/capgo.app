/**
 * Exhaustive backtest for billing_period_stats cycle math.
 *
 * Independent oracle (Stripe-style DOM clamping + UTC midnight bounds) is
 * compared against a TypeScript port of billing_period_completed_cycle(), then
 * against the metrics half-open → inclusive mapping used by cron_email.ts.
 *
 * Goal: catch skipped months, overlapping periods, inverted ranges, and
 * off-by-one metric days before customers see wrong numbers.
 */
import { describe, expect, it } from 'vitest'
import { billingPeriodStatsTestUtils } from '../supabase/functions/_backend/triggers/cron_email.ts'

const { billingPeriodMetricsRange } = billingPeriodStatsTestUtils

type Cycle = {
  isAnniversary: boolean
  cycleStart: string | null
  cycleEnd: string | null
}

function daysInMonthUtc(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function utcDateOnly(year: number, month1to12: number, day: number): string {
  return `${year}-${pad2(month1to12)}-${pad2(day)}`
}

function utcMidnightIso(year: number, month1to12: number, day: number): string {
  return `${utcDateOnly(year, month1to12, day)}T00:00:00.000Z`
}

function parseUtcDateOnly(dateOnly: string): { y: number, m: number, d: number } {
  const [y, m, d] = dateOnly.split('-').map(Number)
  return { y, m, d }
}

function addMonthsUtc(year: number, month1to12: number, delta: number): { y: number, m: number } {
  const idx = year * 12 + (month1to12 - 1) + delta
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }
}

/** Independent Stripe-style completed-cycle oracle (UTC midnight bounds). */
function oracleCompletedCycle(anchorDom: number, asOf: string): Cycle {
  const { y, m, d } = parseUtcDateOnly(asOf)
  const thisLast = daysInMonthUtc(y, m)
  const prev = addMonthsUtc(y, m, -1)
  const prevLast = daysInMonthUtc(prev.y, prev.m)
  const thisAnniv = Math.min(anchorDom, thisLast)
  const prevAnniv = Math.min(anchorDom, prevLast)
  if (d !== thisAnniv) {
    return { isAnniversary: false, cycleStart: null, cycleEnd: null }
  }
  return {
    isAnniversary: true,
    cycleStart: utcMidnightIso(prev.y, prev.m, prevAnniv),
    cycleEnd: utcMidnightIso(y, m, thisAnniv),
  }
}

/**
 * Port of public.billing_period_completed_cycle() from
 * supabase/migrations/20260725112951_register_billing_period_stats_email_cron.sql
 * Keep in lockstep with that SQL.
 */
function sqlPortCompletedCycle(anchorStartIso: string, asOf: string): Cycle {
  const anchor = new Date(anchorStartIso)
  const anchorDom = anchor.getUTCDate() || 1
  const { y, m, d } = parseUtcDateOnly(asOf)
  const thisLast = daysInMonthUtc(y, m)
  const prev = addMonthsUtc(y, m, -1)
  const prevLast = daysInMonthUtc(prev.y, prev.m)
  const thisAnniv = Math.min(anchorDom, thisLast)
  const prevAnniv = Math.min(anchorDom, prevLast)
  const isAnniversary = d === thisAnniv
  if (!isAnniversary) {
    return { isAnniversary: false, cycleStart: null, cycleEnd: null }
  }
  return {
    isAnniversary: true,
    cycleStart: utcMidnightIso(prev.y, prev.m, prevAnniv),
    cycleEnd: utcMidnightIso(y, m, thisAnniv),
  }
}

function eachUtcDate(start: string, endInclusive: string): string[] {
  const out: string[] = []
  let cur = new Date(`${start}T00:00:00.000Z`)
  const end = new Date(`${endInclusive}T00:00:00.000Z`)
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10))
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000)
  }
  return out
}

function inclusiveDayCount(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00.000Z`).getTime()
  const b = new Date(`${end}T00:00:00.000Z`).getTime()
  return Math.round((b - a) / (24 * 60 * 60 * 1000)) + 1
}

function halfOpenCreditSum(
  events: Array<{ at: string, credits: number }>,
  startIso: string,
  endIso: string,
): number {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  return events
    .filter(e => Date.parse(e.at) >= start && Date.parse(e.at) < end)
    .reduce((sum, e) => sum + e.credits, 0)
}

describe('billing_period_stats exhaustive backtest', () => {
  it('sql port matches independent oracle for every day 2024-01-01..2026-12-31 and DOM 1-31', () => {
    const mismatches: string[] = []
    let anniversaryCount = 0

    for (const asOf of eachUtcDate('2024-01-01', '2026-12-31')) {
      for (let dom = 1; dom <= 31; dom++) {
        // Anchor in a month that always has this DOM (January).
        const anchorIso = utcMidnightIso(2024, 1, Math.min(dom, 31))
        // For DOM>days in Jan we still only test 1-31; Jan has 31.
        const oracle = oracleCompletedCycle(dom, asOf)
        const port = sqlPortCompletedCycle(anchorIso, asOf)
        if (
          oracle.isAnniversary !== port.isAnniversary
          || oracle.cycleStart !== port.cycleStart
          || oracle.cycleEnd !== port.cycleEnd
        ) {
          mismatches.push(`dom=${dom} asOf=${asOf} oracle=${JSON.stringify(oracle)} port=${JSON.stringify(port)}`)
        }
        if (oracle.isAnniversary)
          anniversaryCount++
      }
    }

    expect(mismatches.slice(0, 20)).toEqual([])
    // 31 DOMs × 36 months = 1116 anniversary emails across 3 years
    expect(anniversaryCount).toBe(31 * 36)
  })

  it('never skips a calendar month for any DOM (including 29-31)', () => {
    const gaps: string[] = []

    for (let dom = 1; dom <= 31; dom++) {
      const months = new Set<string>()
      for (const asOf of eachUtcDate('2024-01-01', '2026-12-31')) {
        const cycle = oracleCompletedCycle(dom, asOf)
        if (cycle.isAnniversary && cycle.cycleEnd) {
          months.add(cycle.cycleEnd.slice(0, 7))
        }
      }
      for (let y = 2024; y <= 2026; y++) {
        for (let m = 1; m <= 12; m++) {
          const key = `${y}-${pad2(m)}`
          if (!months.has(key))
            gaps.push(`dom=${dom} missing month ${key}`)
        }
      }
    }

    expect(gaps).toEqual([])
  })

  it('consecutive completed cycles abut with no gap or overlap', () => {
    const breaks: string[] = []

    for (let dom = 1; dom <= 31; dom++) {
      const cycles: Array<{ start: string, end: string }> = []
      for (const asOf of eachUtcDate('2024-01-01', '2026-12-31')) {
        const cycle = oracleCompletedCycle(dom, asOf)
        if (cycle.isAnniversary && cycle.cycleStart && cycle.cycleEnd) {
          cycles.push({ start: cycle.cycleStart, end: cycle.cycleEnd })
        }
      }
      cycles.sort((a, b) => a.end.localeCompare(b.end))
      for (let i = 1; i < cycles.length; i++) {
        if (cycles[i - 1]!.end !== cycles[i]!.start) {
          breaks.push(
            `dom=${dom} prevEnd=${cycles[i - 1]!.end} nextStart=${cycles[i]!.start}`,
          )
        }
      }
    }

    expect(breaks.slice(0, 20)).toEqual([])
  })

  it('metrics inclusive ranges cover every day in [start, end) and only those days', () => {
    const bad: string[] = []

    for (const dom of [1, 15, 28, 29, 30, 31]) {
      for (const asOf of eachUtcDate('2024-01-01', '2026-12-31')) {
        const cycle = oracleCompletedCycle(dom, asOf)
        if (!cycle.isAnniversary || !cycle.cycleStart || !cycle.cycleEnd)
          continue

        const range = billingPeriodMetricsRange(cycle.cycleStart, cycle.cycleEnd)
        const days = inclusiveDayCount(range.periodStart, range.metricsEndInclusive)
        if (days < 28 || days > 31) {
          bad.push(`dom=${dom} asOf=${asOf} days=${days} range=${JSON.stringify(range)}`)
        }

        // Half-open [start, end) day count must equal inclusive metrics days.
        const halfOpenDays = Math.round(
          (Date.parse(cycle.cycleEnd) - Date.parse(cycle.cycleStart)) / (24 * 60 * 60 * 1000),
        )
        if (halfOpenDays !== days) {
          bad.push(`dom=${dom} asOf=${asOf} halfOpen=${halfOpenDays} inclusive=${days}`)
        }

        // End day itself must NOT be in metrics (belongs to next cycle).
        if (range.metricsEndInclusive >= range.periodEndExclusive) {
          bad.push(`dom=${dom} asOf=${asOf} metrics includes exclusive end`)
        }
      }
    }

    expect(bad.slice(0, 20)).toEqual([])
  })

  it('known Stripe-style month-end cases match expected completed cycles', () => {
    const cases: Array<{
      dom: number
      asOf: string
      start: string
      end: string
    }> = [
      { dom: 31, asOf: '2026-01-31', start: '2025-12-31', end: '2026-01-31' },
      { dom: 31, asOf: '2026-02-28', start: '2026-01-31', end: '2026-02-28' },
      { dom: 31, asOf: '2026-03-31', start: '2026-02-28', end: '2026-03-31' },
      { dom: 31, asOf: '2026-04-30', start: '2026-03-31', end: '2026-04-30' },
      { dom: 31, asOf: '2026-05-31', start: '2026-04-30', end: '2026-05-31' },
      { dom: 31, asOf: '2024-02-29', start: '2024-01-31', end: '2024-02-29' },
      { dom: 31, asOf: '2024-03-31', start: '2024-02-29', end: '2024-03-31' },
      { dom: 30, asOf: '2026-02-28', start: '2026-01-30', end: '2026-02-28' },
      { dom: 30, asOf: '2026-03-30', start: '2026-02-28', end: '2026-03-30' },
      { dom: 29, asOf: '2025-02-28', start: '2025-01-29', end: '2025-02-28' },
      { dom: 15, asOf: '2026-07-15', start: '2026-06-15', end: '2026-07-15' },
      { dom: 1, asOf: '2026-03-01', start: '2026-02-01', end: '2026-03-01' },
    ]

    for (const c of cases) {
      const cycle = sqlPortCompletedCycle(utcMidnightIso(2024, 1, c.dom), c.asOf)
      expect(cycle, JSON.stringify(c)).toEqual({
        isAnniversary: true,
        cycleStart: `${c.start}T00:00:00.000Z`,
        cycleEnd: `${c.end}T00:00:00.000Z`,
      })
      const metrics = billingPeriodMetricsRange(cycle.cycleStart!, cycle.cycleEnd!)
      expect(metrics.periodStart).toBe(c.start)
      expect(metrics.periodEndExclusive).toBe(c.end)
      expect(metrics.metricsEndInclusive < c.end).toBe(true)
    }
  })

  it('does not fire on non-anniversary days for month-end anchors', () => {
    // 31st anchor must NOT email on Mar 28/29/30 — only Mar 31 (and Feb 28).
    for (const asOf of ['2026-03-28', '2026-03-29', '2026-03-30']) {
      expect(oracleCompletedCycle(31, asOf).isAnniversary).toBe(false)
    }
    expect(oracleCompletedCycle(31, '2026-03-31').isAnniversary).toBe(true)
    expect(oracleCompletedCycle(31, '2026-02-27').isAnniversary).toBe(false)
    expect(oracleCompletedCycle(31, '2026-02-28').isAnniversary).toBe(true)
  })

  it('credit half-open sum excludes end boundary and includes start', () => {
    const start = '2026-06-15T00:00:00.000Z'
    const end = '2026-07-15T00:00:00.000Z'
    const events = [
      { at: '2026-06-14T23:59:59.999Z', credits: 100 }, // before
      { at: '2026-06-15T00:00:00.000Z', credits: 1.5 }, // start incl
      { at: '2026-07-14T12:00:00.000Z', credits: 2.5 }, // mid
      { at: '2026-07-15T00:00:00.000Z', credits: 9 }, // end excl
      { at: '2026-07-15T15:00:00.000Z', credits: 50 }, // after
    ]
    expect(halfOpenCreditSum(events, start, end)).toBe(4)
  })

  it('noon UTC cron always reports a cycle that already ended (no future cycle_end)', () => {
    const cronHourUtc = 12
    const futureEnds: string[] = []

    for (const dom of [1, 15, 28, 29, 30, 31]) {
      for (const asOf of eachUtcDate('2024-01-01', '2026-12-31')) {
        const cycle = oracleCompletedCycle(dom, asOf)
        if (!cycle.isAnniversary || !cycle.cycleEnd)
          continue
        // Cron runs at 12:00 UTC on asOf; cycle_end is asOf 00:00 UTC.
        const cronNow = Date.parse(`${asOf}T${pad2(cronHourUtc)}:00:00.000Z`)
        const cycleEnd = Date.parse(cycle.cycleEnd)
        if (cycleEnd > cronNow) {
          futureEnds.push(`dom=${dom} asOf=${asOf} cycleEnd=${cycle.cycleEnd}`)
        }
      }
    }

    expect(futureEnds).toEqual([])
  })

  it('old get_cycle_info_org day-offset math diverges on month-end (documents why email uses clamp helper)', () => {
    // Reproduce the buggy "date_trunc(month) + (anchor - trunc(anchor))" path
    // for a 31st anchor in February — proves the email must NOT use that path.
    const anchor = new Date('2026-01-31T15:00:00.000Z')
    const anchorDayMs = anchor.getTime() - Date.UTC(2026, 0, 1)
    const febStart = Date.UTC(2026, 1, 1)
    const buggy = new Date(febStart + anchorDayMs)
    // Feb 1 + 30 days = Mar 3 — not a valid Feb anniversary.
    expect(buggy.toISOString().slice(0, 10)).toBe('2026-03-03')

    const clamped = oracleCompletedCycle(31, '2026-02-28')
    expect(clamped.isAnniversary).toBe(true)
    expect(clamped.cycleEnd).toBe('2026-02-28T00:00:00.000Z')
  })

  it('synthetic daily metrics: inclusive range sums only in-cycle days', () => {
    // Simulate daily bandwidth 1 per day; email must report exact day count.
    const cycle = oracleCompletedCycle(15, '2026-07-15')
    const range = billingPeriodMetricsRange(cycle.cycleStart!, cycle.cycleEnd!)
    const allDays = eachUtcDate('2026-06-01', '2026-07-31')
    let sum = 0
    for (const day of allDays) {
      if (day >= range.periodStart && day <= range.metricsEndInclusive)
        sum += 1
    }
    expect(sum).toBe(inclusiveDayCount(range.periodStart, range.metricsEndInclusive))
    expect(sum).toBe(30) // Jun 15 .. Jul 14 inclusive
    // Day of cycle end must not be counted
    expect(range.periodEndExclusive).toBe('2026-07-15')
    expect(range.metricsEndInclusive).toBe('2026-07-14')
  })
})
