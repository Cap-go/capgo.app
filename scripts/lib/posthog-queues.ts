import process from 'node:process'

export const POSTHOG_RETENTION_SECONDS = 14 * 24 * 60 * 60
export type QueueEnvironment = 'alpha' | 'preprod' | 'prod'
export interface QueueInfo {
  queue_id: string
  queue_name: string
  settings?: { message_retention_period?: number, delivery_paused?: boolean }
  consumers?: Array<{ type?: string, settings?: { max_retries?: number } }>
}
export type QueueApi = <T>(path: string, method?: string, body?: unknown) => Promise<T>

export function queueEnvironment(value: string): QueueEnvironment {
  if (!['alpha', 'preprod', 'prod'].includes(value))
    throw new Error('Expected alpha, preprod, or prod')
  return value as QueueEnvironment
}

export function createQueueApi(): QueueApi {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !account || !/^[\da-f]{32}$/i.test(account))
    throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID')
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      const data = await response.json() as { success?: boolean, result?: T }
      if (!response.ok || data.success !== true)
        throw new Error('Queue API request rejected')
      return data.result as T
    }
    catch {
      // Provider errors can echo submitted message bodies or authentication material.
      throw new Error('Cloudflare Queue API request failed; no payload was logged')
    }
  }
}

export async function findQueue(api: QueueApi, name: string): Promise<QueueInfo | undefined> {
  const queues = await api<QueueInfo[]>(`?name=${encodeURIComponent(name)}`)
  if (!Array.isArray(queues))
    throw new Error('Invalid queue listing')
  const matches = queues.filter(queue => queue.queue_name === name)
  if (matches.length > 1)
    throw new Error('Ambiguous queue name')
  return matches.length ? api<QueueInfo>(`/${matches[0].queue_id}`) : undefined
}

export async function verifiedQueue(api: QueueApi, name: string) {
  const queue = await findQueue(api, name)
  if (!queue || queue.settings?.message_retention_period !== POSTHOG_RETENTION_SECONDS)
    throw new Error(`Queue missing or retention is not fourteen days: ${name}`)
  return queue
}
