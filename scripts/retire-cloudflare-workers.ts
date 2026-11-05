import type { QueueApi } from './lib/posthog-queues.ts'
import process from 'node:process'
import { createQueueApi, findQueue } from './lib/posthog-queues.ts'

// Workers whose code was removed from the repository keep running (crons,
// queue consumers) until they are deleted from Cloudflare. List them here so
// the production deploy removes them; entries are idempotent and can be
// dropped once they are gone.
export const RETIRED_WORKERS: ReadonlyArray<{ worker: string, queues: readonly string[] }> = [
  // Bento evaluation dispatcher, removed in #3809. Its every-minute cron
  // still queried the dropped public.bento_evaluation_runs table.
  { worker: 'capgo-bento-dispatch-prod', queues: ['capgo-bento-dispatch-prod'] },
]

export type ScriptApi = (name: string) => Promise<'deleted' | 'missing'>

export function createScriptApi(): ScriptApi {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !account || !/^[\da-f]{32}$/i.test(account))
    throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID')
  return async (name) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(name)}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 404)
      return 'missing'
    const data = await response.json().catch(() => ({})) as { success?: boolean }
    if (!response.ok || data.success !== true)
      throw new Error(`Cloudflare rejected deleting Worker ${name} (HTTP ${response.status})`)
    return 'deleted'
  }
}

export async function retireCloudflareWorkers(scripts: ScriptApi, queues: QueueApi, retired = RETIRED_WORKERS) {
  for (const { worker, queues: names } of retired) {
    // Delete the Worker first so its queue consumer binding is gone before the queue.
    console.log(`Worker ${worker}: ${await scripts(worker)}`)
    for (const name of names) {
      const queue = await findQueue(queues, name)
      if (queue)
        await queues(`/${queue.queue_id}`, 'DELETE')
      console.log(`Queue ${name}: ${queue ? 'deleted' : 'missing'}`)
    }
  }
}

if (import.meta.main) {
  try {
    await retireCloudflareWorkers(createScriptApi(), createQueueApi())
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Retiring Cloudflare Workers failed')
    process.exitCode = 1
  }
}
