import type { ABTestConfig } from '../supabase/functions/_backend/utils/ab_test_allocation.ts'
import { describe, expect, it } from 'vitest'
import { AB_TEST_INTENTS, createABTestAssignments, resolveABTestAssignments, validateABTestsConfig } from '../supabase/functions/_backend/utils/ab_test_allocation.ts'
import rawConfig from '../supabase/functions/_backend/utils/ab_tests.json'
import { PROSPECTIVE_COHORT_FIXTURE } from './helpers/ab-test-prospective-cohort.ts'

const timestamp = '2026-10-18T00:00:00.000Z'
const assignment = (branch = 'A') => ({ branch, assigned_at: timestamp })
const cohortConfig = validateABTestsConfig({ ...rawConfig, ...PROSPECTIVE_COHORT_FIXTURE })
const user = (intent: unknown, extra = {}) => ({ id: 'new-account-1', created_at: timestamp, created_via_invite: false, intent, abtests_enrolled: ['new_emails_v2'], ...extra })
function experiment(name: string, extra: Partial<ABTestConfig> = {}): ABTestConfig {
  return {
    audience: 'all',
    label: name,
    treatment_branch: 'A',
    control_branch: 'B',
    treatment_percentage: 50,
    branches: { A: { bento_tag: `ab:${name}`, label: 'Treatment' }, B: { bento_tag: `ab:no_${name}`, label: 'Control' } },
    ...extra,
  }
}

describe('generic intent allocation', () => {
  it('resolves prerequisites before dependents regardless of declaration order', () => {
    const entries = {
      dependent: experiment('dependent', { treatment_percentage: 100, required_assignments: { prerequisite: 'A' } }),
      prerequisite: experiment('prerequisite', { treatment_percentage: 100 }),
    }
    const forward = createABTestAssignments(user('builder'), validateABTestsConfig(entries), () => 0, () => new Date(timestamp))
    const reversed = createABTestAssignments(user('builder'), validateABTestsConfig(Object.fromEntries(Object.entries(entries).reverse())), () => 0, () => new Date(timestamp))
    expect(forward).toEqual(reversed)
    expect(forward.dependent).toEqual(assignment())
  })

  it('keeps varying random draws stable across declaration order', () => {
    const entries = {
      dependent: experiment('dependent', { treatment_percentage: 100, required_assignments: { prerequisite: 'A' } }),
      prerequisite: experiment('prerequisite'),
      other: experiment('other'),
    }
    const run = (value: unknown) => {
      const rolls = [0.1, 0.9, 0.9]
      return createABTestAssignments(user('builder'), validateABTestsConfig(value), () => rolls.shift()!, () => new Date(timestamp))
    }
    expect(run(entries)).toEqual(run(Object.fromEntries(Object.entries(entries).reverse())))
  })

  it('keeps nested intent dependency ordering independent of JSON declaration order', () => {
    const requirements = { builder: { z_prerequisite: 'A' }, ota: { z_other: 'A' } }
    const run = (required: unknown) => {
      const rolls = [0.1, 0.9, 0.9]
      const config = validateABTestsConfig({
        a_dependent: experiment('a_dependent', { treatment_percentage: 100, required_assignments_by_intent: required as never }),
        z_prerequisite: experiment('z_prerequisite'),
        z_other: experiment('z_other'),
      })
      return createABTestAssignments(user('builder'), config, () => rolls.shift()!, () => new Date(timestamp))
    }
    expect(run(requirements)).toEqual(run(Object.fromEntries(Object.entries(requirements).reverse())))
  })

  it('breaks collation ties consistently when experiment names have equivalent Unicode forms', () => {
    const entries = [['é', experiment('é')], ['e\u0301', experiment('e\u0301')]] as const
    const run = (value: unknown) => {
      const rolls = [0.1, 0.9]
      return createABTestAssignments(user('ota'), validateABTestsConfig(value), () => rolls.shift()!, () => new Date(timestamp))
    }
    expect(run(Object.fromEntries(entries))).toEqual(run(Object.fromEntries([...entries].reverse())))
  })

  it('fails closed when a prior account forges a prospective marker', () => {
    const result = createABTestAssignments(user('builder', { created_at: '2026-01-01T00:00:00.000Z' }), cohortConfig, () => 0)
    expect(result).not.toHaveProperty('new_emails_v2')
  })

  it('uses an existing prerequisite control without rerolling it', () => {
    const config = validateABTestsConfig({
      dependent: experiment('dependent', { treatment_percentage: 100, required_assignments: { prerequisite: 'A' } }),
      prerequisite: experiment('prerequisite', { treatment_percentage: 100 }),
    })
    const result = resolveABTestAssignments(user('builder'), { prerequisite: assignment('B') }, config, () => 0, () => new Date(timestamp))
    expect(result.assignments).toEqual({ prerequisite: assignment('B') })
  })

  it.each([undefined, null, '', 'unknown', 'OTA', 'publish'])('defers v2 for missing or unsupported intent %s', (intent) => {
    expect(createABTestAssignments(user(intent), cohortConfig)).not.toHaveProperty('new_emails_v2')
  })

  it.each(AB_TEST_INTENTS.flatMap(intent => [false, true].map(invited => ({ intent, invited }))))('assigns new emails to every $intent user (invited: $invited)', ({ intent, invited }) => {
    const result = createABTestAssignments(user(intent, { created_via_invite: invited }), validateABTestsConfig(rawConfig), () => 0.9999)
    expect(result.new_emails?.branch).toBe('A')
    expect(result).not.toHaveProperty('new_emails_v2')
  })

  it.each([undefined, null, 'unknown'])('does not assign new emails for missing or unsupported intent %s', (intent) => {
    expect(createABTestAssignments(user(intent), validateABTestsConfig(rawConfig), () => 0)).not.toHaveProperty('new_emails')
  })

  it('allocates 50% OTA deterministically and leaves the remainder out of the v2 cohort', () => {
    const config = cohortConfig
    let treatmentCount = 0
    for (let index = 0; index < 10000; index++) {
      const account = user('ota', { id: `account-${index}` })
      const first = createABTestAssignments(account, config, () => 0, () => new Date(timestamp))
      const retry = createABTestAssignments(account, config, () => 0.9999, () => new Date(timestamp))
      expect(first).toEqual(retry)
      expect(first.new_emails?.branch).toBe('A')
      if (first.new_emails_v2) {
        expect(first.new_emails_v2.branch).toBe('A')
        treatmentCount++
      }
    }
    expect(treatmentCount).toBeGreaterThan(4500)
    expect(treatmentCount).toBeLessThan(5500)
  })

  it('enrolls new self-signup builder treatment users and excludes checklist controls', () => {
    const config = cohortConfig
    const account = user('builder')
    expect(createABTestAssignments(account, config, () => 0).new_emails_v2?.branch).toBe('A')
    expect(createABTestAssignments(account, config, () => 0.99).new_emails_v2?.branch).toBe('A')
    expect(resolveABTestAssignments(account, { builder_todo_list_v4: assignment('B') }, config).assignments).not.toHaveProperty('new_emails_v2')
  })

  it.each(['ota', 'builder'])('excludes invited %s users from new and stored v2 assignments', (intent) => {
    const config = cohortConfig
    const eligible = Array.from({ length: 100 }, (_, index) => user(intent, { id: `self-signup-${index}` }))
      .find(account => createABTestAssignments(account, config, () => 0).new_emails_v2)
    expect(eligible).toBeDefined()
    const invited = { ...eligible!, created_via_invite: true }
    expect(createABTestAssignments(invited, config, () => 0)).not.toHaveProperty('new_emails_v2')
    const result = resolveABTestAssignments(invited, { builder_todo_list_v4: assignment(), new_emails_v2: assignment() }, config)
    expect(result.assignments).not.toHaveProperty('new_emails_v2')
    expect(result.nextAssignments).not.toHaveProperty('new_emails_v2')
  })

  it('never backfills prior users through recomputation even with builder treatment', () => {
    const result = resolveABTestAssignments(user('builder', { abtests_enrolled: undefined }), {
      builder_todo_list_v4: assignment(),
      retired_experiment: assignment(),
    }, cohortConfig)
    expect(result.assignments.builder_todo_list_v4).toEqual(assignment())
    expect(result.assignments).not.toHaveProperty('new_emails_v2')
    expect(result.nextAssignments.retired_experiment).toEqual(assignment())
  })

  it.each(AB_TEST_INTENTS)('moves a stored old-email control to new emails and keeps retired v2 data for %s', (intent) => {
    const config = validateABTestsConfig(rawConfig)
    const result = resolveABTestAssignments(user(intent), { new_emails: assignment('B'), new_emails_v2: assignment() }, config, () => 0.9999, () => new Date(timestamp))
    expect(result.assignments.new_emails).toEqual(assignment())
    expect(result.nextAssignments.new_emails_v2).toEqual(assignment())
    expect(resolveABTestAssignments(user(intent), { new_emails: assignment() }, config).assignments.new_emails).toEqual(assignment())
  })

  it('keeps an OTA exclusion stable after switching through Builder treatment', () => {
    const config = cohortConfig
    const excluded = Array.from({ length: 100 }, (_, index) => user('ota', { id: `account-${index}` }))
      .find(account => !createABTestAssignments(account, config).new_emails_v2)!
    const builder = resolveABTestAssignments({ ...excluded, intent: 'builder' }, { builder_todo_list_v4: assignment() }, config)
    expect(builder.assignments.new_emails_v2?.branch).toBe('A')
    expect(resolveABTestAssignments(excluded, builder.nextAssignments, config).assignments).not.toHaveProperty('new_emails_v2')
  })

  it('revokes dependents when prerequisites or intent stop matching without rerolling unrelated branches', () => {
    const config = cohortConfig
    const result = resolveABTestAssignments(user('builder'), {
      new_emails_v2: assignment(),
      builder_todo_list_v4: assignment('B'),
      webnativeapp_publish_intent: assignment('B'),
    }, config)
    expect(result.assignments).not.toHaveProperty('new_emails_v2')
    expect(result.assignments.webnativeapp_publish_intent).toEqual(assignment('B'))
  })

  it.each([null, { branch: 'legacy', assigned_at: timestamp }, { branch: 'A' }])('repairs malformed eligible assignments without changing valid branches: %j', (malformed) => {
    const config = validateABTestsConfig({
      damaged: experiment('damaged'),
      stable: experiment('stable'),
    })
    const result = resolveABTestAssignments(user('ota'), { damaged: malformed, stable: assignment('B') }, config, () => 0, () => new Date(timestamp))
    expect(result.assignments).toEqual({ damaged: assignment(), stable: assignment('B') })
    expect(result.nextAssignments).toEqual(result.assignments)
  })

  it('omits malformed assignments during read-only tag reconciliation', () => {
    const config = validateABTestsConfig({ damaged: experiment('damaged') })
    const result = resolveABTestAssignments(user('ota'), { damaged: { branch: 'legacy' } }, config, () => 0, () => new Date(timestamp), false)
    expect(result.assignments).toEqual({})
    expect(result.nextAssignments).toEqual({})
  })

  it.each([
    { treatment_percentage_by_intent: { invalid: 50 } },
    { treatment_percentage_by_intent: { ota: 100.1 } },
    { treatment_percentage_by_intent: { ota: -1 } },
    { required_assignments: { missing: 'A' } },
    { required_assignments: { target: 'A' } },
    { required_assignments_by_intent: { invalid: { other: 'A' } } },
    { required_assignments: { other: 'C' } },
    { required_assignments: { other: 'A' }, required_assignments_by_intent: { builder: { other: 'B' } } },
    { assign_control: 'no' },
    { allocation: 'unknown' },
    { enroll_new_users_after: 'invalid' },
  ])('rejects invalid allocation and dependency config %j', (extra) => {
    expect(() => validateABTestsConfig({ target: experiment('target', extra as never), other: experiment('other') })).toThrow('Invalid A/B test configuration')
  })

  it.each(['__proto__', 'constructor', 'prototype'])('rejects reserved experiment name %s', (name) => {
    expect(() => validateABTestsConfig(Object.fromEntries([[name, experiment(name)]]))).toThrow('Invalid A/B test configuration')
  })

  it('rejects dependency cycles including intent-specific edges', () => {
    expect(() => validateABTestsConfig({
      target: experiment('target', { required_assignments_by_intent: { builder: { other: 'A' } } }),
      other: experiment('other', { required_assignments: { target: 'A' } }),
    })).toThrow('Invalid A/B test configuration')
  })
})
