import { describe, expect, it } from 'vitest'
import {
  READ_REPLICA_REFRESH_SUBSCRIPTION_SQL,
  checkSubscriptionPublicationAlignment,
  publicationTablesMissingFromSubscription,
  subscriptionPublicationCheckOutcome,
} from '../scripts/sync-read-replica-schema.ts'

describe('read-replica subscription publication alignment', () => {
  it.concurrent('reports OK when every publication table is subscribed', async () => {
    const publication = ['apps', 'channels', 'orgs']
    const outcome = subscriptionPublicationCheckOutcome(publication, publication)
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines).toEqual([
      'Read-replica subscription covers every table in the primary publication.',
    ])

    const exitCode = await checkSubscriptionPublicationAlignment({
      queryPublicationTables: async () => publication,
      querySubscriptionTables: async () => publication,
    })
    expect(exitCode).toBe(0)
  })

  it.concurrent('warns with the manual refresh command when tables are missing', async () => {
    const missing = publicationTablesMissingFromSubscription(
      ['apps', 'delta_files', 'orgs'],
      ['apps', 'orgs'],
    )
    expect(missing).toEqual(['delta_files'])

    const outcome = subscriptionPublicationCheckOutcome(
      ['apps', 'delta_files', 'orgs'],
      ['apps', 'orgs'],
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines[0]).toMatch(/^::warning title=Read-replica subscription missing publication tables::/)
    expect(outcome.lines[0]).toContain('delta_files')
    expect(outcome.lines[0]).toContain(READ_REPLICA_REFRESH_SUBSCRIPTION_SQL)

    const exitCode = await checkSubscriptionPublicationAlignment({
      queryPublicationTables: async () => ['apps', 'delta_files', 'orgs'],
      querySubscriptionTables: async () => ['apps', 'orgs'],
    })
    expect(exitCode).toBe(0)
  })

  it.concurrent('warns when the primary publication returns no tables', () => {
    const outcome = subscriptionPublicationCheckOutcome([], ['apps'])
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines[0]).toMatch(/^::warning title=Read-replica publication empty::/)
  })

  it.concurrent('fails when a publication query throws', async () => {
    await expect(checkSubscriptionPublicationAlignment({
      queryPublicationTables: async () => {
        throw new Error('primary down')
      },
      querySubscriptionTables: async () => ['apps'],
    })).rejects.toThrow('primary down')
  })
})
