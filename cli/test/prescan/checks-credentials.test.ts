// test/prescan/checks-credentials.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { credentialsSaved } from '../../src/build/prescan/checks/credentials'
import { apikeyPermission, appExists } from '../../src/build/prescan/checks/shared-remote'
import { makeCtx, makeProject } from './helpers'

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function installAppVisibleFetch(opts: { visible?: boolean, error?: Error }) {
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/private/cli/apps/visible')) {
      if (opts.error)
        throw opts.error
      return new Response(JSON.stringify({ visible: opts.visible === true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
}

function installPermissionFetch(opts: { allowed?: boolean, error?: Error }) {
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/private/config'))
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/private/cli/permissions')) {
      if (opts.error)
        throw opts.error
      return new Response(JSON.stringify({ permissions: { 'app.build_native': opts.allowed === true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
}

function fakeClient() {
  return { apikey: 'k', apiHost: 'http://localhost:54321/functions/v1', filesHost: 'http://localhost:54321/functions/v1' }
}

describe('shared/apikey-permission', () => {
  it('errors when permission rpc returns false', async () => {
    installPermissionFetch({ allowed: false })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', client: fakeClient() })
    const findings = await apikeyPermission.run(ctx)
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.title).toContain('app.build_native')
  })
  it('passes when permission granted', async () => {
    installPermissionFetch({ allowed: true })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', client: fakeClient() })
    expect(await apikeyPermission.run(ctx)).toEqual([])
  })
  it('downgrades a network/API failure to info — never blocks offline users (spec)', async () => {
    installPermissionFetch({ error: new Error('fetch failed') })
    const ctx = makeCtx({ projectDir: '/tmp', apikey: 'k', client: fakeClient() })
    const findings = await apikeyPermission.run(ctx)
    expect(findings[0]?.severity).toBe('info')
    expect(findings[0]?.title).toContain('Could not verify')
  })
})

describe('shared/app-exists', () => {
  it('errors when app row is absent', async () => {
    installAppVisibleFetch({ visible: false })
    const ctx = makeCtx({ projectDir: '/tmp', client: fakeClient() })
    expect((await appExists.run(ctx))[0]?.severity).toBe('error')
  })
  it('passes when app found', async () => {
    installAppVisibleFetch({ visible: true })
    const ctx = makeCtx({ projectDir: '/tmp', client: fakeClient() })
    expect(await appExists.run(ctx)).toEqual([])
  })
  it('downgrades a network/API failure to info — never blocks offline users (spec)', async () => {
    installAppVisibleFetch({ error: new Error('fetch failed') })
    const ctx = makeCtx({ projectDir: '/tmp', client: fakeClient() })
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
    const f = (await credentialsSaved.run(ctx))[0]
    expect(f?.detail).toContain('KEYSTORE_KEY_ALIAS')
  })
  it('passes with complete android credentials', async () => {
    const ctx = makeCtx({ projectDir: makeProject({}), platform: 'android', credentials: {
      ANDROID_KEYSTORE_FILE: 'x', KEYSTORE_KEY_ALIAS: 'a', KEYSTORE_STORE_PASSWORD: 'p',
    } })
    expect(await credentialsSaved.run(ctx)).toEqual([])
  })
})
