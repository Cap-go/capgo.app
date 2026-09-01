// test/prescan/checks-credentials.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import { credentialsSaved } from '../../src/build/prescan/checks/credentials'
import { apikeyPermission, appExists } from '../../src/build/prescan/checks/shared-remote'
import { makeCtx, makeProject } from './helpers'

const realFetch = globalThis.fetch
const HOST = { supaHost: 'https://fake.supabase.co', supaAnon: 'fake-anon' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function installFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return handler(url)
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('shared/apikey-permission', () => {
  it('errors when permission HTTP returns false', async () => {
    installFetch((url) => {
      if (url.includes('/private/cli/check-permission'))
        return json({ allowed: false })
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', ...HOST })
    const findings = await apikeyPermission.run(ctx)
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.title).toContain('app.build_native')
  })
  it('passes when permission granted', async () => {
    installFetch((url) => {
      if (url.includes('/private/cli/check-permission'))
        return json({ allowed: true })
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', ...HOST })
    expect(await apikeyPermission.run(ctx)).toEqual([])
  })
  it('downgrades a network/API failure to info — never blocks offline users (spec)', async () => {
    installFetch(() => {
      throw new TypeError('fetch failed')
    })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', ...HOST })
    const findings = await apikeyPermission.run(ctx)
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.title).toContain('Could not verify')
  })
})

describe('shared/app-exists', () => {
  it('errors when app row is absent', async () => {
    installFetch((url) => {
      if (url.includes('/app/'))
        return json({ error: 'not_found' }, 404)
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', ...HOST })
    expect((await appExists.run(ctx))[0]?.severity).toBe('error')
  })
  it('passes when app found', async () => {
    installFetch((url) => {
      if (url.includes('/app/'))
        return json({ app_id: 'com.demo.app' })
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', ...HOST })
    expect(await appExists.run(ctx)).toEqual([])
  })
  it('downgrades a network/API failure to info — never blocks offline users (spec)', async () => {
    installFetch(() => {
      throw new TypeError('fetch failed')
    })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', ...HOST })
    const findings = await appExists.run(ctx)
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.title).toContain('Could not verify')
  })
})

describe('shared/credentials-saved', () => {
  it('errors when no credentials at all', async () => {
    const ctx = makeCtx({ projectDir: makeProject({}), platform: 'ios', credentials: undefined })
    expect((await credentialsSaved.run(ctx))[0]?.severity).toBe('error')
  })
  it('errors listing missing required ios keys', async () => {
    const ctx = makeCtx({ projectDir: makeProject({}), platform: 'ios', credentials: { BUILD_CERTIFICATE_BASE64: 'x' } })
    const f = (await credentialsSaved.run(ctx))[0]
    expect(f?.severity).toBe('error')
    expect(f?.detail).toContain('CAPGO_IOS_PROVISIONING_MAP')
  })
  it('errors listing missing required android keys', async () => {
    const ctx = makeCtx({ projectDir: makeProject({}), platform: 'android', credentials: { ANDROID_KEYSTORE_FILE: 'x' } })
    expect((await credentialsSaved.run(ctx))[0]?.detail).toContain('KEYSTORE_KEY_ALIAS')
  })
  it('passes with complete android credentials', async () => {
    const ctx = makeCtx({ projectDir: makeProject({}), platform: 'android', credentials: {
      ANDROID_KEYSTORE_FILE: 'x', KEYSTORE_KEY_ALIAS: 'a', KEYSTORE_STORE_PASSWORD: 'p',
    } })
    expect(await credentialsSaved.run(ctx)).toEqual([])
  })
})
