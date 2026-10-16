import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDispatchJob } from '../cloudflare_workers/bento_dispatch/operations.ts'

describe('approved evaluation runner replacement', () => {
  it('accepts an evaluation identifier and stable UUID without recipient portions', () => {
    const job = { version: 1, evaluationKey: 'org:invite_new_user_reminder_1', runId: '11111111-1111-4111-8111-111111111111' }
    expect(() => parseDispatchJob(job)).not.toThrow()
  })
  it('keeps exactly the two private ledgers and removes scheduled recipient enrollment', () => {
    const sql = readFileSync('supabase/migrations/20261015164155_bento_invitation_dispatches.sql', 'utf8')
    expect(sql).toContain('CREATE TABLE public.bento_evaluation_runs')
    expect(sql).not.toMatch(/\bdue_at\b|\bpartition\b|CREATE TRIGGER/)
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(2)
    expect(sql).toContain('pending_audit')
  })
})
