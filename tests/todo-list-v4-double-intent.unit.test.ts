import { describe, expect, it } from 'vitest'
import { createABTestAssignments, resolveABTestAssignments, validateABTestsConfig } from '../supabase/functions/_backend/utils/ab_test_allocation.ts'
import rawConfig from '../supabase/functions/_backend/utils/ab_tests.json'

const name = 'todo_list_v4_double_intent'
const at = '2026-10-18T00:00:00.000Z'

describe('double intent checklist experiment', () => {
  it('declares an independent, disabled self-signup experiment with unique tags', () => {
    const config = validateABTestsConfig(rawConfig)
    expect(config[name]).toMatchObject({
      label: 'ToDoList V4 Double Intent',
      audience: 'self_signup',
      intents: ['both', 'exploring'],
      treatment_percentage: 0,
      treatment_branch: 'A',
      control_branch: 'B',
    })
    const tags = Object.values(config).flatMap(test => Object.values(test.branches).map(branch => branch.bento_tag))
    expect(new Set(tags).size).toBe(tags.length)
  })

  it.concurrent.each(['both', 'exploring', 'ota', 'builder', undefined])('assigns nobody at 0%% for intent %s, and preserves existing assignments', (intent) => {
    const config = validateABTestsConfig(rawConfig)
    const withoutNew = validateABTestsConfig(Object.fromEntries(Object.entries(rawConfig).filter(([key]) => key !== name)))
    for (const invited of [false, true]) {
      const user = { id: 'disabled-double-intent', created_via_invite: invited, intent }
      const baseline = createABTestAssignments(user, withoutNew, () => 0, () => new Date(at))
      const result = resolveABTestAssignments(user, baseline, config, () => 0, () => new Date(at))
      expect(result.assignments).toEqual(baseline)
      expect(result.changed).toBe(false)
      expect(result.assignments).not.toHaveProperty(name)
    }
  })

  it.concurrent.each(['both', 'exploring'])('retains controlled A and B fixtures for eligible %s users without rerolling them', (intent) => {
    const config = validateABTestsConfig(rawConfig)
    for (const branch of ['A', 'B']) {
      const existing = { [name]: { branch, assigned_at: at } }
      const result = resolveABTestAssignments({ created_via_invite: false, intent }, existing, config, () => 0.99)
      expect(result.assignments[name]).toEqual(existing[name])
    }
  })
})
