import { describe, expect, it } from 'vitest'
import * as pluginRuntimeRollout from '../supabase/functions/_backend/plugin_runtime/utils/rollout.ts'
import { getRolloutBucketBps, resolveRolloutDecision, stableHash32 } from '../supabase/functions/_backend/utils/rollout.ts'

const baseDecision = {
  appId: 'com.test.rollout',
  channelId: 1,
  currentVersionName: '1.0.0',
  deviceId: 'device-a',
  rolloutEnabled: true,
  rolloutId: '11111111-1111-4111-8111-111111111111',
  rolloutPausedAt: null,
  rolloutPercentageBps: 0,
  rolloutVersionId: 10,
  rolloutVersionName: '1.1.0',
}

const SAMPLE_SIZE = 10_000

function syntheticDeviceId(index: number) {
  // UUID-shaped ids that only differ in their trailing counter, the worst case
  // for weak hashes.
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function selectedDevices(percentageBps: number, overrides: Partial<typeof baseDecision> = {}) {
  const selected = new Set<string>()
  for (let index = 0; index < SAMPLE_SIZE; index++) {
    const deviceId = syntheticDeviceId(index)
    const decision = resolveRolloutDecision({ ...baseDecision, ...overrides, deviceId, rolloutPercentageBps: percentageBps })
    if (decision.selected)
      selected.add(deviceId)
  }
  return selected
}

describe('rollout deterministic assignment', () => {
  it.concurrent('keeps utils and plugin_runtime copies identical', () => {
    for (let index = 0; index < 200; index++) {
      const input = { ...baseDecision, deviceId: syntheticDeviceId(index), rolloutPercentageBps: 3300 }
      expect(pluginRuntimeRollout.resolveRolloutDecision(input)).toEqual(resolveRolloutDecision(input))
    }
  })

  it.concurrent('hash is stable across calls', () => {
    expect(stableHash32('device-a')).toBe(stableHash32('device-a'))
    expect(stableHash32('device-a')).not.toBe(stableHash32('device-b'))
    expect(stableHash32('')).toBe(stableHash32(''))
  })

  it.concurrent('returns the same decision for the same device on every call', () => {
    for (let index = 0; index < 500; index++) {
      const input = { ...baseDecision, deviceId: syntheticDeviceId(index), rolloutPercentageBps: 2500 }
      const first = resolveRolloutDecision(input)
      for (let repeat = 0; repeat < 3; repeat++)
        expect(resolveRolloutDecision(input)).toEqual(first)
    }
  })

  it.concurrent('buckets are in [0, 10000) and ignore device id casing', () => {
    for (let index = 0; index < 1000; index++) {
      const bucket = getRolloutBucketBps({ ...baseDecision, deviceId: syntheticDeviceId(index) })
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(10000)
      expect(Number.isInteger(bucket)).toBe(true)
    }
    expect(getRolloutBucketBps({ ...baseDecision, deviceId: 'ABC-DEF' })).toBe(getRolloutBucketBps({ ...baseDecision, deviceId: 'abc-def' }))
  })

  it.concurrent('distributes devices uniformly (within 2 points of the target)', () => {
    for (const percentageBps of [100, 1000, 2500, 5000, 9000]) {
      const ratio = selectedDevices(percentageBps).size / SAMPLE_SIZE
      expect(Math.abs(ratio - percentageBps / 10000)).toBeLessThanOrEqual(0.02)
    }

    // Every decile of the bucket space gets about 10% of devices.
    const deciles: number[] = Array.from({ length: 10 }).fill(0) as number[]
    for (let index = 0; index < SAMPLE_SIZE; index++)
      deciles[Math.floor(getRolloutBucketBps({ ...baseDecision, deviceId: syntheticDeviceId(index) }) / 1000)]++
    for (const count of deciles)
      expect(Math.abs(count / SAMPLE_SIZE - 0.1)).toBeLessThanOrEqual(0.02)
  })

  it.concurrent('raising the percentage only adds devices (monotonic)', () => {
    let previous = new Set<string>()
    for (const percentageBps of [0, 1, 500, 1000, 2500, 5000, 7500, 10000]) {
      const current = selectedDevices(percentageBps)
      for (const deviceId of previous)
        expect(current.has(deviceId)).toBe(true)
      expect(current.size).toBeGreaterThanOrEqual(previous.size)
      previous = current
    }
    expect(previous.size).toBe(SAMPLE_SIZE)
  })

  it.concurrent('lowering the percentage only removes devices', () => {
    const wide = selectedDevices(5000)
    const narrow = selectedDevices(2000)
    for (const deviceId of narrow)
      expect(wide.has(deviceId)).toBe(true)
  })

  it.concurrent('reshuffles the cohort for a new rollout', () => {
    const current = selectedDevices(5000)
    const nextRollout = selectedDevices(5000, { rolloutId: '22222222-2222-4222-8222-222222222222' })
    const nextVersion = selectedDevices(5000, { rolloutVersionId: 11 })
    const otherChannel = selectedDevices(5000, { channelId: 2 })
    for (const other of [nextRollout, nextVersion, otherChannel]) {
      const overlap = [...current].filter(deviceId => other.has(deviceId)).length / current.size
      // Independent 50% cohorts overlap by ~50%; identical cohorts would be 100%.
      expect(overlap).toBeGreaterThan(0.45)
      expect(overlap).toBeLessThan(0.55)
    }
  })

  it.concurrent('returns stable at 0 percent and rollout at 100 percent', () => {
    expect(resolveRolloutDecision({ ...baseDecision, rolloutPercentageBps: 0 })).toMatchObject({ selected: false, reason: 'percentage_zero' })
    expect(resolveRolloutDecision({ ...baseDecision, rolloutPercentageBps: 10000 })).toMatchObject({ selected: true, reason: 'bucket_selected' })
    expect(resolveRolloutDecision({ ...baseDecision, rolloutPercentageBps: 25000 })).toMatchObject({ selected: true, percentageBps: 10000 })
  })

  it.concurrent('keeps devices already on the rollout bundle selected, even when paused or at 0 percent', () => {
    const deviceOutsideCohort = Array.from({ length: 1000 }, (_, index) => syntheticDeviceId(index))
      .find(deviceId => getRolloutBucketBps({ ...baseDecision, deviceId }) >= 1000)!

    for (const extra of [
      { rolloutPercentageBps: 0 },
      { rolloutPercentageBps: 1000 },
      { rolloutPercentageBps: 1000, rolloutPausedAt: '2026-05-06T11:30:00.000Z' },
    ]) {
      expect(resolveRolloutDecision({
        ...baseDecision,
        ...extra,
        deviceId: deviceOutsideCohort,
        currentVersionName: baseDecision.rolloutVersionName,
      })).toMatchObject({ selected: true, reason: 'already_on_rollout' })
    }
  })

  it.concurrent('does not expose new devices while paused', () => {
    expect(resolveRolloutDecision({
      ...baseDecision,
      rolloutPausedAt: '2026-05-06T11:30:00.000Z',
      rolloutPercentageBps: 10000,
    })).toMatchObject({ selected: false, reason: 'paused' })
  })

  it.concurrent('moves devices back to stable when rollout is disabled', () => {
    expect(resolveRolloutDecision({
      ...baseDecision,
      currentVersionName: '1.1.0',
      rolloutEnabled: false,
      rolloutPercentageBps: 10000,
    })).toMatchObject({ selected: false, reason: 'disabled' })
  })
})
