import { describe, expect, it } from 'vitest'
import {
  READ_REPLICA_REFRESH_SUBSCRIPTION_SQL,
  checkSubscriptionPublicationAlignment,
  publicationTablesMissingFromSubscription,
  subscriptionPublicationCheckOutcome,
} from '../scripts/sync-read-replica-schema.ts'

function readyRows(tables: readonly string[]) {
  return tables.map(table_name => ({ table_name, state: 'r' }))
}

describe('read-replica subscription publication alignment', () => {
  it.concurrent('reports OK when every publication table is subscribed and ready', async () => {
    const publication = ['apps', 'channels', 'orgs']
    const outcome = subscriptionPublicationCheckOutcome(publication, readyRows(publication))
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines).toEqual([
      'Read-replica subscription covers every table in the primary publication and each table is ready (srsubstate r).',
    ])

    const exitCode = await checkSubscriptionPublicationAlignment({
      queryPublicationTables: async () => publication,
      querySubscriptionRows: async () => readyRows(publication),
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
      readyRows(['apps', 'orgs']),
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines[0]).toMatch(/^::warning title=Read-replica subscription missing publication tables::/)
    expect(outcome.lines[0]).toContain('delta_files')
    expect(outcome.lines[0]).toContain(READ_REPLICA_REFRESH_SUBSCRIPTION_SQL)

    const exitCode = await checkSubscriptionPublicationAlignment({
      queryPublicationTables: async () => ['apps', 'delta_files', 'orgs'],
      querySubscriptionRows: async () => readyRows(['apps', 'orgs']),
    })
    expect(exitCode).toBe(0)
  })

  it.concurrent('warns when a subscribed table is still copying', () => {
    const outcome = subscriptionPublicationCheckOutcome(
      ['apps', 'delta_files'],
      [{ table_name: 'apps', state: 'r' }, { table_name: 'delta_files', state: 'd' }],
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines[0]).toMatch(/^::warning title=Read-replica subscription initial copy in progress::/)
    expect(outcome.lines[0]).toContain('delta_files')
  })

  it.concurrent('warns when the primary publication returns no tables', () => {
    const outcome = subscriptionPublicationCheckOutcome([], readyRows(['apps']))
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lines[0]).toMatch(/^::warning title=Read-replica publication empty::/)
  })

  it.concurrent('fails when a publication query throws', async () => {
    await expect(checkSubscriptionPublicationAlignment({
      queryPublicationTables: async () => {
        throw new Error('primary down')
      },
      querySubscriptionRows: async () => readyRows(['apps']),
    })).rejects.toThrow('primary down')
  })
})
