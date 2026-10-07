import type { MessageBatch } from '@cloudflare/workers-types'
import type { Bindings } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { processApiQueueBatch } from '../cloudflare_workers/api/queue.ts'

const { native, posthog } = vi.hoisted(() => ({ native: vi.fn(), posthog: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/nativeNotificationSender.ts', () => ({ processNativeNotificationQueueBatch: native }))
vi.mock('../supabase/functions/_backend/utils/posthog_queue.ts', () => ({ processPostHogQueueBatch: posthog }))
afterEach(() => vi.clearAllMocks())

const config = JSON.parse(readFileSync(new URL('../cloudflare_workers/api/wrangler.jsonc', import.meta.url), 'utf8'))
const commands = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts

describe('queue configuration and strict dispatch', () => {
  it.each(['alpha', 'preprod', 'prod', 'local'])('configures a dedicated PostHog main and DLQ in %s', (environment) => {
    const queues = config.env[environment].queues
    const main = `capgo-posthog-events-${environment}`
    expect(queues.producers.filter((binding: { binding: string }) => binding.binding.startsWith('POSTHOG_'))).toEqual([
      { binding: 'POSTHOG_QUEUE', queue: main },
      { binding: 'POSTHOG_DLQ', queue: `${main}-dlq` },
    ])
    expect(queues.consumers.filter((consumer: { queue: string }) => consumer.queue.startsWith('capgo-posthog'))).toEqual([
      { queue: main, max_batch_size: 10, max_batch_timeout: 5, max_concurrency: 2, max_retries: 5, dead_letter_queue: `${main}-dlq` },
    ])
    expect(queues.consumers.every((consumer: { max_retries: number }) => consumer.max_retries <= 5)).toBe(true)
  })

  it.each([['prod', 'prod'], ['preprod', 'preprod'], ['dev', 'alpha']])('enforces resource verification before %s deployment', (script, environment) => {
    expect(commands[`deploy:cloudflare:api:${script}`]).toMatch(new RegExp(`^bun scripts/ensure-posthog-queues.ts ${environment} && bunx wrangler deploy`))
  })

  it.each(['alpha', 'preprod', 'prod', 'local'])('routes only matching queue names in %s', async (environment) => {
    const env = { ENV_NAME: `capgo_api-${environment}` } as Bindings
    const posthogBatch = { queue: `capgo-posthog-events-${environment}`, messages: [] } as unknown as MessageBatch<unknown>
    await processApiQueueBatch(posthogBatch, env)
    expect(posthog).toHaveBeenCalledWith(posthogBatch, env)
    expect(native).not.toHaveBeenCalled()
    const nativeBatch = { ...posthogBatch, queue: `capgo-native-notifications-${environment}` }
    await processApiQueueBatch(nativeBatch, env)
    expect(native).toHaveBeenCalledWith(nativeBatch, env)
  })

  it.each(['unknown', 'capgo-posthog-events-prod-dlq', 'capgo-posthog-events-alpha'])('does not acknowledge an unknown or mismatched queue %s', async (queue) => {
    const ack = vi.fn()
    await expect(processApiQueueBatch({ queue, messages: [{ ack }] } as unknown as MessageBatch<unknown>, { ENV_NAME: 'capgo_api-prod' } as Bindings)).rejects.toThrow('Unknown API queue')
    expect(ack).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
    expect(posthog).not.toHaveBeenCalled()
  })

  it('leaves messages unacknowledged when environment identity is missing', async () => {
    await expect(processApiQueueBatch({ queue: 'capgo-posthog-events-prod' } as MessageBatch<unknown>, {} as Bindings)).rejects.toThrow('Unknown API queue environment')
  })
})
