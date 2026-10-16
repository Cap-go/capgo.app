import type { QueueApi, QueueInfo } from '../scripts/lib/posthog-queues.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { INVITATION_OPERATIONS } from '../cloudflare_workers/bento_dispatch/operations.ts'
import { resolveDeployScopeFromFiles } from '../scripts/deploy-scope.ts'
import { BENTO_QUEUE_NAME, BENTO_QUEUE_RETENTION_SECONDS, ensureBentoDispatchQueue } from '../scripts/ensure-bento-dispatch-queue.ts'

describe('bento dispatcher infrastructure', () => {
  it('configures one queue with single-message delivery, five concurrent jobs and five total attempts', () => {
    const config = JSON.parse(readFileSync('cloudflare_workers/bento_dispatch/wrangler.jsonc', 'utf8'))
    expect(config.workers_dev).toBe(false)
    expect(config.preview_urls).toBe(false)
    expect(config.env.prod.triggers.crons).toEqual(['* * * * *'])
    expect(config.env.prod.queues.producers).toEqual([{ binding: 'DISPATCH_QUEUE', queue: BENTO_QUEUE_NAME }, { binding: 'POSTHOG_QUEUE', queue: 'capgo-posthog-events-prod' }])
    expect(config.env.prod.queues.consumers).toEqual([{ queue: BENTO_QUEUE_NAME, max_batch_size: 1, max_batch_timeout: 0, max_concurrency: 5, max_retries: 4, retry_delay: 60 }])
    expect(config.env.prod.routes).toBeUndefined()
  })

  it('keeps checkout credentials out of the Bento deployment and passes the tag through quoted environment data', () => {
    const workflow = readFileSync('.github/workflows/build_and_deploy.yml', 'utf8')
    const job = workflow.split('  deploy_bento_dispatch:')[1]!.split('  deploy_r2_inventory:')[0]!
    expect(job).toContain('persist-credentials: false')
    const deployTagExpression = ['$', '{{ needs.changes.outputs.deploy_tag }}'].join('')
    expect(job).toContain(`BENTO_DEPLOY_TAG: ${deployTagExpression}`)
    expect(job).toContain('resolve-deploy-tag.ts --assert-current "$BENTO_DEPLOY_TAG"')
    expect(job).not.toContain('--assert-current "${{')
  })

  it('keeps every recreation flow aligned with a new registered event and an independent email node', () => {
    const manifest = JSON.parse(readFileSync('cloudflare_workers/bento_dispatch/bento/flows.json', 'utf8')) as { flows: Array<{ event: string, subject: string, html: string, transactional: boolean, steps: string[] }> }
    expect(manifest.flows.map(flow => flow.event).sort()).toEqual([...INVITATION_OPERATIONS].sort())
    expect(new Set(manifest.flows.map(flow => flow.html)).size).toBe(4)
    for (const flow of manifest.flows) {
      expect(flow.steps).toEqual(['event_equals', 'send_email', 'exit'])
      expect(flow.transactional).toBe(true)
      expect(flow.subject).toContain('{{ event.details.org_name_subject }}')
      const html = readFileSync(`cloudflare_workers/bento_dispatch/bento/${flow.html}`, 'utf8')
      expect(html).toContain('{{ event.details.invite_link }}')
    }
  })

  it.each(['cloudflare_workers/bento_dispatch/index.ts', 'cloudflare_workers/bento_dispatch/store.ts', 'scripts/ensure-bento-dispatch-queue.ts', 'cloudflare_workers/api/email_templates/render.ts'])('includes %s in dispatcher releases', (file) => {
    expect(resolveDeployScopeFromFiles([file]).bento_dispatch).toBe(true)
  })

  it('redeploys both importing workers when the shared initial-fact helper changes', () => {
    const scope = resolveDeployScopeFromFiles(['supabase/functions/_backend/utils/bento_flow_audit.ts'])
    expect(scope.api).toBe(true)
    expect(scope.bento_dispatch).toBe(true)
    expect(resolveDeployScopeFromFiles(['cloudflare_workers/api/triggers/org_invitation_email.ts']).api).toBe(true)
  })

  it('creates and verifies just the one queue', async () => {
    let queue: QueueInfo | undefined
    const calls: Array<{ path: string, method: string, body: unknown }> = []
    const api: QueueApi = async <T>(path: string, method = 'GET', body?: unknown) => {
      calls.push({ path, method, body })
      if (method === 'POST') {
        queue = { queue_id: 'one', queue_name: BENTO_QUEUE_NAME, settings: { message_retention_period: BENTO_QUEUE_RETENTION_SECONDS } }
        return queue as T
      }
      return (path.startsWith('?') ? (queue ? [queue] : []) : queue) as T
    }
    await ensureBentoDispatchQueue(api)
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '', method: 'POST', body: { queue_name: BENTO_QUEUE_NAME, settings: { message_retention_period: BENTO_QUEUE_RETENTION_SECONDS } } }])
    calls.length = 0
    await ensureBentoDispatchQueue(api)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('fails on a queue lookup error without trying to create or alter resources', async () => {
    const api = vi.fn().mockRejectedValue(new Error('lookup failed'))
    await expect(ensureBentoDispatchQueue(api)).rejects.toThrow('lookup failed')
    expect(api).toHaveBeenCalledOnce()
  })

  it('requires exact queue verification after an uncertain creation', async () => {
    let created = false
    const api: QueueApi = async <T>(path: string, method = 'GET') => {
      if (method === 'POST') {
        created = true
        throw new Error('lost response')
      }
      const queue = { queue_id: 'one', queue_name: BENTO_QUEUE_NAME, settings: { message_retention_period: BENTO_QUEUE_RETENTION_SECONDS } }
      return (path.startsWith('?') ? (created ? [queue] : []) : queue) as T
    }
    await expect(ensureBentoDispatchQueue(api)).resolves.toBeUndefined()
  })
})
