import { afterEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

const TOKEN = '4da517a9663c456b785515ffaf40adbc4279ae7f4ebb360ad66ecf2664345878'
const PATH = `/.well-known/muse-challenge/${TOKEN}`

describe('Muse connector domain verification', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('serves the built-in challenge as plain text with no credentials', async () => {
    vi.stubEnv('MUSE_CHALLENGE_TOKEN', '')
    const response = await apiWorker.fetch(new Request(`https://api.capgo.app${PATH}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toBe(`muse-challenge=${TOKEN}`)
  })

  it('returns 404 for any other token', async () => {
    vi.stubEnv('MUSE_CHALLENGE_TOKEN', '')
    const response = await apiWorker.fetch(new Request(`https://api.capgo.app/.well-known/muse-challenge/${'a'.repeat(64)}`))
    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('Not found')
  })

  it('serves a replacement token from MUSE_CHALLENGE_TOKEN', async () => {
    const replacement = 'b'.repeat(64)
    vi.stubEnv('MUSE_CHALLENGE_TOKEN', ` ${replacement} `)
    const builtIn = await apiWorker.fetch(new Request(`https://api.capgo.app${PATH}`))
    expect(builtIn.status).toBe(404)
    const response = await apiWorker.fetch(new Request(`https://api.capgo.app/.well-known/muse-challenge/${replacement}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
    await expect(response.text()).resolves.toBe(`muse-challenge=${replacement}`)
  })
})
