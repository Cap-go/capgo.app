import { describe, expect, it } from 'vitest'
import { runProbes } from '@openstatus/health'
import { failingProbe, okProbe } from '@openstatus/health/testing'
import apiWorker from '../cloudflare_workers/api/index.ts'
import pluginWorker from '../cloudflare_workers/plugin/index.ts'

describe('capgo /health endpoint', () => {
  it.concurrent('returns openstatus JSON on api worker GET /health', async () => {
    const response = await apiWorker.fetch(new Request('https://api.preprod.capgo.app/health'))
    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(600)
    const body = await response.json() as {
      status: string
      checkedAt: string
      checks?: Array<{ name: string, status: string }>
      version?: string
    }
    expect(body.status).toMatch(/^(ok|degraded|unhealthy)$/)
    expect(body.checkedAt).toBeTruthy()
    expect(Array.isArray(body.checks)).toBe(true)
    expect(body.checks?.some(check => check.name === 'database')).toBe(true)
    if (body.status === 'ok')
      expect(body.version).toBeTruthy()
  })

  it.concurrent('supports HEAD on api worker /health', async () => {
    const getResponse = await apiWorker.fetch(new Request('https://api.preprod.capgo.app/health'))
    const headResponse = await apiWorker.fetch(new Request('https://api.preprod.capgo.app/health', { method: 'HEAD' }))
    expect(headResponse.status).toBe(getResponse.status)
    expect(await headResponse.text()).toBe('')
  })

  it.concurrent('exposes /health on plugin worker with database probe', async () => {
    const response = await pluginWorker.fetch(new Request('https://plugin.preprod.capgo.app/health'))
    const body = await response.json() as { status: string, checks?: Array<{ name: string }> }
    expect(body.status).toMatch(/^(ok|degraded|unhealthy)$/)
    expect(response.status).toBe(body.status === 'unhealthy' ? 503 : 200)
    expect(body.checks?.some(check => check.name === 'database')).toBe(true)
  })

  it.concurrent('aggregates critical probe failures as unhealthy', async () => {
    const report = await runProbes([
      okProbe('runtime'),
      failingProbe('database', true),
    ])
    expect(report.status).toBe('unhealthy')
  })
})
