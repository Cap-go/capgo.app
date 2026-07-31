// test/prescan/request-gate.test.ts
// Wiring tests for the prescan gate inside requestBuildInternal.
import type { BuildRequestOptions } from '../../src/schemas/build'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'bun:test'
import { executePrescan } from '../../src/build/prescan/command'
import { requestBuildInternal } from '../../src/build/request'
import { makeProject } from './helpers'

const realFetch = globalThis.fetch

describe('build request rejects contradictory prescan flags', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('--prescan-ignore-fatal + --fail-on-warnings fails before any network call', async () => {
    const result = await requestBuildInternal(
      'com.demo.app',
      // prescan: true mirrors what requestBuildCommand injects for `build request` (the only
      // entrypoint that opts in). The gate + flag validation are opt-in (options.prescan === true).
      { platform: 'android', prescan: true, prescanIgnoreFatal: true, failOnWarnings: true } as BuildRequestOptions,
      true, // silent: no clack output from the test
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/contradictory/i)
    // proves the validation throws before a job is ever requested
    expect(result.jobId).toBeUndefined()
  })

  it('--no-prescan skips the flag validation (combination is then irrelevant)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as typeof fetch
    const result = await requestBuildInternal(
      'com.demo.app',
      {
        platform: 'android',
        prescan: false,
        prescanIgnoreFatal: true,
        failOnWarnings: true,
        // empty project: the run fails fast and offline at the capacitor-config step,
        // proving it got PAST flag validation
        path: makeProject({}),
        apikey: 'fake-key-for-test',
        supaHost: 'https://fake.supabase.co',
        supaAnon: 'fake-anon',
      } as BuildRequestOptions,
      true,
    )
    expect(result.success).toBe(false)
    expect(result.error ?? '').not.toMatch(/contradictory/i)
  })
})

// Locks the deletion-before-gate invariant for play-sa-access on the
// --no-playstore-upload path: request.ts deletes PLAY_CONFIG_JSON from
// mergedCredentials (request.ts:1393) BEFORE handing the SAME object to
// executePrescan at the gate (request.ts:1620). willUploadToPlay keys purely
// off ctx.credentials.PLAY_CONFIG_JSON, so the deletion must suppress the
// outbound Google probe. These tests run the real executePrescan seam with a
// global-fetch spy so any Play network attempt is observable (and hermetic: no
// real Google call is ever allowed).
describe('play-sa-access probe is gated by PLAY_CONFIG_JSON presence in the threaded credentials', () => {
  const PLAY_JSON_B64 = Buffer.from(JSON.stringify({
    type: 'service_account',
    client_email: 'ci@demo.iam.gserviceaccount.com',
    project_id: 'demo-proj',
    private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
    token_uri: 'https://oauth2.googleapis.com/token',
  }), 'utf8').toString('base64')

  const ANDROID_PROJECT = {
    'android/app/build.gradle': 'android {\n  defaultConfig {\n    applicationId "com.demo.app"\n  }\n}\n',
  }

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Block all outbound fetch so any Play network attempt fails fast and hermetically. */
  function installFetchSpy(): void {
    globalThis.fetch = (async () => {
      // Fail closed: a blocked call becomes a clean network-error in the
      // validator, so the scan still completes without a real Google request.
      throw new Error('network blocked in test')
    }) as typeof fetch
  }

  it('runs the Play access check when PLAY_CONFIG_JSON is present in the credentials', async () => {
    installFetchSpy()
    const { report } = await executePrescan('com.demo.app', {
      platform: 'android',
      path: makeProject(ANDROID_PROJECT),
      credentials: { PLAY_CONFIG_JSON: PLAY_JSON_B64 },
    })
    // The check's appliesTo passed and it ran -> it emits a play-sa-access
    // finding (info/error/warning depending on the offline outcome).
    expect(report.findings.some(f => f.id === 'android/play-sa-access')).toBe(true)
  })

  it('does NOT run the Play access check once PLAY_CONFIG_JSON is deleted (the --no-playstore-upload contract)', async () => {
    installFetchSpy()
    // Mirror request.ts:1393 — playstoreUpload === false deletes the key from the
    // SAME credentials object that is then threaded into executePrescan (:1620).
    const mergedCredentials: Record<string, string> = { PLAY_CONFIG_JSON: PLAY_JSON_B64 }
    delete mergedCredentials.PLAY_CONFIG_JSON
    const { report } = await executePrescan('com.demo.app', {
      platform: 'android',
      path: makeProject(ANDROID_PROJECT),
      credentials: mergedCredentials,
    })
    // appliesTo (willUploadToPlay) is false -> the check never runs, so there is
    // no play-sa-access finding of any severity.
    expect(report.findings.some(f => f.id === 'android/play-sa-access')).toBe(false)
  })
})

// Integration tests that drive the REAL requestBuildInternal through the gate
// and the relocated permission backstop. They are hermetic: every fetch is
// routed through a spy, so no Supabase RPC, no /private/config, and no
// /build/request ever leaves the process. The spy lets us (a) control the
// cli_check_permission result, (b) observe whether /build/request was POSTed.
//
// A capacitor.config.json + minimal Android credentials get the run PAST
// getConfig and the credential-validation step so it reaches the gate/assert.
// supaHost/supaAnon make createSupabaseClient build a real client pointed at a
// fake URL whose RPC/select calls the spy answers.
interface GateProbe {
  postedBuildRequest: boolean
  urls: string[]
}

/**
 * Route all outbound fetch. cli_check_permission returns `permission`; the
 * /build/request POST is recorded (and answered 200) so a regression that
 * reached the POST would still flip postedBuildRequest to true; everything
 * else (getRemoteConfig, apps select) gets a benign empty 200.
 */
function installGateFetchSpy(permission: boolean): GateProbe {
  const probe: GateProbe = { postedBuildRequest: false, urls: [] }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    probe.urls.push(url)
    if (url.includes('cli_check_permission'))
      return json(permission)
    if (url.includes('/build/request')) {
      probe.postedBuildRequest = true
      return json({ jobId: 'should-never-be-reached' })
    }
    // apps select (getOrganizationId), getRemoteConfig, and any other supabase
    // call: a benign empty payload. getOrganizationId's empty result is
    // swallowed (orgId=''), exactly as in production.
    return json({})
  }) as typeof fetch
  return probe
}

/** Android project that reaches the gate; gradle shape toggles the blocking error. */
function gateProject(opts: { withApplicationId: boolean }): string {
  return makeProject({
    'capacitor.config.json': JSON.stringify({ appId: 'com.demo.app', appName: 'demo', webDir: 'dist' }),
    'android/app/build.gradle': opts.withApplicationId
      ? 'android {\n  defaultConfig {\n    applicationId "com.demo.app"\n  }\n}\n'
      // No applicationId + no productFlavors -> android/applicationid-present errors (offline, deterministic).
      : 'android {\n  defaultConfig {\n  }\n}\n',
  })
}

/** Build options that get the run past credential validation to the gate/assert. */
function gateOptions(extra: Partial<BuildRequestOptions>): BuildRequestOptions {
  return {
    platform: 'android',
    apikey: 'fake-key-for-test',
    supaHost: 'https://fake.supabase.co',
    supaAnon: 'fake-anon',
    androidKeystoreFile: '/tmp/fake.keystore',
    keystoreKeyAlias: 'alias',
    keystoreKeyPassword: 'pass',
    outputUpload: true, // satisfies the "build has no output destination" check without PLAY_CONFIG_JSON
    ...extra,
  } as BuildRequestOptions
}

describe('prescan gate: a blocking error throws and never POSTs /build/request (no orphaned job)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('blocks the build, returns {success:false}, and never reaches /build/request', async () => {
    // permission=true so the ONLY thing that can stop the build is the gate.
    const probe = installGateFetchSpy(true)
    const result = await requestBuildInternal(
      'com.demo.app',
      gateOptions({ prescan: true, path: gateProject({ withApplicationId: false }) }),
      true,
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not requested and nothing was uploaded/i)
    expect(result.jobId).toBeUndefined()
    // The load-bearing invariant: no server-side job is created on a block.
    expect(probe.postedBuildRequest).toBe(false)
  })
})

describe('permission backstop fires before the POST on the prescan-skipped and -bypassed paths', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('--no-prescan: an unauthorized key is rejected before /build/request', async () => {
    const probe = installGateFetchSpy(false)
    const result = await requestBuildInternal(
      'com.demo.app',
      gateOptions({ prescan: false, path: gateProject({ withApplicationId: true }) }),
      true,
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/insufficient permissions to request a native build/i)
    expect(probe.postedBuildRequest).toBe(false)
  })

  it('--prescan-ignore-fatal: the backstop still denies an unauthorized key after the gate is bypassed', async () => {
    // ignoreFatal makes the gate PROCEED (even on errors), so the relocated
    // assertCliPermission is the only thing standing between an unauthorized
    // key and the POST. It must still deny.
    const probe = installGateFetchSpy(false)
    const result = await requestBuildInternal(
      'com.demo.app',
      gateOptions({ prescan: true, prescanIgnoreFatal: true, path: gateProject({ withApplicationId: true }) }),
      true,
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/insufficient permissions to request a native build/i)
    expect(probe.postedBuildRequest).toBe(false)
  })
})
