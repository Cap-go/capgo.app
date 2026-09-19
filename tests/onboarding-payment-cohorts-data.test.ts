import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { Pool as PgPool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { queryOnboardingPaymentCohortData } from '../supabase/functions/_backend/utils/onboarding_payment_cohorts_data.ts'

let pool: Pool
const period = { start: '2096-06-01T00:00:00.000Z', cutoff: '2096-09-16T00:00:00.000Z' }

beforeAll(async () => {
  // An explicit local fixture DB supports SQL-only validation without Docker.
  // CI defaults to the worktree-isolated Supabase database and its actual schema.
  const connectionString = env.ONBOARDING_COHORT_TEST_DB_URL
    ?? (await import('./test-utils.ts')).POSTGRES_URL
  pool = new PgPool({ connectionString, max: 2 })
})

afterAll(async () => {
  await pool?.end()
})

describe('payment cohort source SQL against PostgreSQL', () => {
  it.concurrent('retains missing profiles, uses the auth clock and scopes paid credits to non-invited org creators', async () => {
    const client = await pool.connect()
    const [owner, invited, missing, old, today, member] = Array.from({ length: 6 }, () => String(randomUUID()))
    const [ownedOrg, invitedOrg, otherOrg] = Array.from({ length: 3 }, () => String(randomUUID()))
    const paidGrant = randomUUID()
    const delayedGrant = randomUUID()
    try {
      await client.query('BEGIN')
      // Suppress application triggers only within this rolled-back fixture transaction.
      // Fixtures must not enqueue email/billing jobs or alter shared seed resources.
      await client.query("SET LOCAL session_replication_role = 'replica'")
      for (const [id, createdAt] of [
        [owner, '2096-06-30T23:59:59Z'], [invited, '2096-09-01T00:00:00Z'],
        [missing, '2096-08-01T00:00:00Z'], [old, '2096-05-31T23:59:59Z'],
        [today, period.cutoff], [member, '2096-07-01T00:00:00Z'],
      ]) {
        await client.query('INSERT INTO auth.users (id, email, created_at) VALUES ($1, $2, $3)', [id, `cohort-${id}@example.com`, createdAt])
      }
      for (const id of [owner, invited, old, today, member]) {
        await client.query('INSERT INTO public.users (id, email, created_at, created_via_invite) VALUES ($1, $2, $3, $4)', [id, `cohort-${id}@example.com`, '2096-09-10T00:00:00Z', id === invited])
      }
      for (const [id, creator] of [[ownedOrg, owner], [invitedOrg, invited], [otherOrg, old]]) {
        await client.query('INSERT INTO public.orgs (id, name, management_email, created_by, customer_id) VALUES ($1, $2, $3, $4, $5)', [id, `Cohort fixture ${id}`, 'cohort-billing@example.com', creator, `cus_fake_${id}`])
      }
      for (const [id, orgId, source, total, grantedAt] of [
        [paidGrant, ownedOrg, 'stripe_top_up', 12.5, '2096-07-01T00:00:00Z'],
        [randomUUID(), ownedOrg, 'manual', 10, '2096-07-01T00:00:00Z'],
        [randomUUID(), ownedOrg, 'stripe_top_up', 0, '2096-07-01T00:00:00Z'],
        [randomUUID(), invitedOrg, 'stripe_top_up', 10, '2096-09-02T00:00:00Z'],
        [randomUUID(), otherOrg, 'stripe_top_up', 10, '2096-07-01T00:00:00Z'],
        [delayedGrant, ownedOrg, 'stripe_top_up', 10, period.cutoff],
      ]) {
        await client.query('INSERT INTO public.usage_credit_grants (id, org_id, source, credits_total, granted_at, source_ref) VALUES ($1, $2, $3, $4, $5, $6)', [id, orgId, source, total, grantedAt, { paymentIntentId: 'pi_fixture_paid' }])
      }

      const data = await queryOnboardingPaymentCohortData(client, period)
      const fixtureUsers = data.users.filter(user => [owner, invited, missing, old, today, member].includes(user.id))
      expect(fixtureUsers.map(user => user.id).sort()).toEqual([owner, invited, missing, member].sort())
      expect(fixtureUsers.find(user => user.id === owner)?.signup_at).toBe('2096-06-30T23:59:59.000Z')
      expect(fixtureUsers.find(user => user.id === missing)?.has_public_row).toBe(false)
      expect(fixtureUsers.find(user => user.id === invited)?.created_via_invite).toBe(true)
      expect(data.orgs.filter(org => [ownedOrg, invitedOrg, otherOrg].includes(org.id)).map(org => org.id)).toEqual([ownedOrg])
      const fixtureGrants = data.grants.filter(grant => [ownedOrg, invitedOrg, otherOrg].includes(grant.org_id))
      expect(fixtureGrants.map(grant => grant.id).sort()).toEqual([paidGrant, delayedGrant].sort())
      expect(fixtureGrants.find(grant => grant.id === paidGrant)).toMatchObject({ org_id: ownedOrg, credits_total: 12.5, payment_intent_id: 'pi_fixture_paid' })
      // A grant confirmed after midnight can prove an invoice paid before cutoff;
      // the aggregation layer must filter its selected payment timestamp instead.
      expect(fixtureGrants.find(grant => grant.id === delayedGrant)?.granted_at).toBe(period.cutoff)
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it.concurrent('returns empty source arrays for a signup period without fixture users', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const data = await queryOnboardingPaymentCohortData(client, { start: '2100-01-01T00:00:00.000Z', cutoff: '2100-04-01T00:00:00.000Z' })
      expect(data).toEqual({ users: [], orgs: [], grants: [] })
    }
    finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
