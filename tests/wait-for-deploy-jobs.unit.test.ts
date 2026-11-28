import { describe, expect, it } from 'vitest'
import { evaluateGate, parseGateArgs } from '../scripts/wait-for-deploy-jobs.ts'

const supabase = 'Build code and deploy to Supabase'
const refresh = 'Refresh production read-replica subscription'
const job = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion })

describe('deploy job gate', () => {
  it('proceeds only when every job ended as success or skipped', () => {
    expect(evaluateGate([job(supabase, 'completed', 'success'), job(refresh, 'completed', 'skipped')], [supabase, refresh])).toEqual({ state: 'proceed' })
  })

  it('waits for jobs that are running, queued or not listed yet, and tells which have not started', () => {
    // A running job ends on its own timeout, so only unstarted ones count against the gate's.
    expect(evaluateGate([job(supabase, 'completed', 'success'), job(refresh, 'in_progress')], [supabase, refresh]))
      .toEqual({ state: 'wait', pending: [refresh], unstarted: [] })
    expect(evaluateGate([job(supabase, 'queued')], [supabase, refresh]))
      .toEqual({ state: 'wait', pending: [supabase, refresh], unstarted: [supabase, refresh] })
  })

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', null])('fails when a job ends with %s', (conclusion) => {
    expect(evaluateGate([job(supabase, 'completed', conclusion), job(refresh, 'in_progress')], [supabase, refresh]).state).toBe('fail')
  })

  it('treats skipped as failure when success is required', () => {
    expect(evaluateGate([job(supabase, 'completed', 'skipped')], [supabase], { requireSuccess: true }).state).toBe('fail')
    expect(evaluateGate([job(supabase, 'completed', 'success')], [supabase], { requireSuccess: true })).toEqual({ state: 'proceed' })
  })

  it('fails instead of guessing when two jobs share a name', () => {
    expect(evaluateGate([job(supabase, 'completed', 'success'), job(supabase, 'completed', 'success')], [supabase]).state).toBe('fail')
  })

  it('parses job names and the timeout', () => {
    expect(parseGateArgs(['--timeout-minutes', '10', supabase, refresh])).toEqual({ timeoutMinutes: 10, requireSuccess: false, names: [supabase, refresh] })
    expect(parseGateArgs(['--require-success', supabase])).toEqual({ timeoutMinutes: 45, requireSuccess: true, names: [supabase] })
    expect(() => parseGateArgs([])).toThrow()
    expect(() => parseGateArgs(['--timeout-minutes', '0', supabase])).toThrow()
  })
})
