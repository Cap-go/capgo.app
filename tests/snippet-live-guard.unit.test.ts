import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readLiveGuard } from '../scripts/check-live-snippet-guard.mjs'
import { matchesComponent } from '../scripts/release-scope'

const expected = 'export default { fetch() {} }\n'
const privateMarker = 'private-provider-detail.example.com'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const calls: { url: string, method: string | undefined }[] = []
  const rules = [{ snippet_name: 'plugin_load_balancer', expression: `http.host eq "${privateMarker}"`, enabled: true }]
  let ruleReads = 0
  let live = expected
  let extraModule = false
  let drift = false
  let denied = false
  let malformed = false
  let oversized = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method })
    expect(init?.headers).toEqual({ Authorization: 'Bearer fake-token' })
    expect(init?.redirect).toBe('error')
    if (denied)
      return new Response(privateMarker, { status: 403 })
    if (url.endsWith('/snippet_rules')) {
      ruleReads++
      if (malformed) return Response.json({ success: true, result: [privateMarker] })
      return Response.json({ success: true, result: drift && ruleReads === 2
        ? rules.map(rule => ({ ...rule, expression: 'http.host eq "another.example.com"' })) : rules })
    }
    if (oversized) return new Response('x'.repeat(50_000))
    const form = new FormData()
    form.append('files', new File([live], 'snippet.js', { type: 'application/javascript+module' }))
    if (extraModule) form.append('files', new File(['export {}'], 'other.js'))
    return new Response(form)
  }
  return { calls, rules, fetcher, setLive: (value: string) => { live = value },
    extra: () => { extraModule = true }, drift: () => { drift = true },
    deny: () => { denied = true }, malformed: () => { malformed = true }, oversized: () => { oversized = true } }
}

describe('live snippet proof reads', () => {
  it.concurrent('uses three bounded GETs and returns only sanitized metadata', async () => {
    const f = fixture()
    const result = await readLiveGuard({ token: 'fake-token', expected, fetcher: f.fetcher })
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET'])
    expect(f.calls.map(call => new URL(call.url).pathname.split('/snippets')[1]))
      .toEqual(['/snippet_rules', '/plugin_load_balancer/content', '/snippet_rules'])
    expect(result.live).toBe(expected)
    expect(result.receipt).toMatchObject({ requests: 3, moduleSha256: hash(expected),
      compiledModuleEqualsLive: true, rulesStableDuringRead: true, pluginRuleEnabled: true, ruleCount: 1,
      ruleExpressionCoverageVerified: false })
    expect(JSON.stringify(result.receipt)).not.toContain(privateMarker)
    expect(JSON.stringify(result.receipt)).not.toContain(expected)
    expect(JSON.stringify(result.receipt)).not.toContain('fake-token')
  })

  it.concurrent.each(['different module', 'multiple modules', 'disabled rule', 'duplicate rule', 'rule drift', 'denied', 'malformed', 'oversized'] as const)
    ('fails safely for %s without retrying or writing', async (kind) => {
      const f = fixture()
      if (kind === 'different module') f.setLive(privateMarker)
      if (kind === 'multiple modules') f.extra()
      if (kind === 'disabled rule') f.rules[0].enabled = false
      if (kind === 'duplicate rule') f.rules.push({ ...f.rules[0] })
      if (kind === 'rule drift') f.drift()
      if (kind === 'denied') f.deny()
      if (kind === 'malformed') f.malformed()
      if (kind === 'oversized') f.oversized()
      const failure = await readLiveGuard({ token: 'fake-token', expected, fetcher: f.fetcher }).catch((error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain(privateMarker)
      expect(f.calls.every(call => call.method === 'GET')).toBe(true)
      expect(f.calls.length).toBeLessThanOrEqual(3)
      if (kind === 'denied') expect(f.calls).toHaveLength(1)
      if (kind === 'rule drift') expect(String(failure)).toContain('rules_changed_during_read')
    })

  it.concurrent('rejects missing credentials before making a request', async () => {
    const f = fixture()
    await expect(readLiveGuard({ token: '', expected, fetcher: f.fetcher })).rejects.toThrow('invalid_check_configuration')
    expect(f.calls).toHaveLength(0)
  })
})

describe('compiled snippet guard proof', () => {
  it('exercises the real compiled module and rejects a removed KV guard without real providers', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'snippet-guard-test-'))
    try {
      const output = execFileSync('bun', ['--eval', `
        const { buildSnippets } = await import('./scripts/snippet/build-snippets.ts')
        const module = (await buildSnippets()).find(item => item.name === 'plugin_load_balancer')
        process.stdout.write(module.code)
      `], { encoding: 'utf8' })
      const validate = async (code: string) => {
        await writeFile(resolve(directory, 'expected.mjs'), code)
        await writeFile(resolve(directory, 'live.mjs'), code)
        await writeFile(resolve(directory, 'capture.json'), JSON.stringify({ moduleSha256: hash(code) }))
        return execFileSync('node', ['--experimental-vm-modules', 'scripts/check-live-snippet-guard.mjs', 'validate', directory], {
          encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
      expect(JSON.parse(await validate(output))).toMatchObject({ guard: { passed: 37, realNetworkCalls: 0, fakeFixturesOnly: true },
        rolloutReadinessVerified: false, incidentResolutionVerified: false, actualProductionExecutionObserved: false })
      await rm(resolve(directory, 'result.json'))
      const predicate = /\.startsWith\((["'])kv\1\)/g
      expect([...output.matchAll(predicate)]).toHaveLength(1)
      const unguarded = output.replace(predicate, '.startsWith("disabled-kv")')
      expect(unguarded).not.toBe(output)
      try {
        await validate(unguarded)
        expect.fail('The removed KV guard must fail its behavioral contract')
      }
      catch (error) {
        if (!(error instanceof Error) || !('stderr' in error))
          throw error
        expect(String(error.stderr)).toContain('"reason":"guard_behavior_failed"')
      }
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('manual live snippet workflow', () => {
  it.concurrent('pins trusted source, keeps credentials in the GET step and retains only the sanitized result', async () => {
    const workflow = parse(await readFile('.github/workflows/check_live_snippet_guard.yml', 'utf8'))
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const job = workflow.jobs.check
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).toContain("github.repository == 'Cap-go/capgo.app'")
    expect(job.steps[0].with.ref).toBe('${{ github.workflow_sha }}')
    expect(job.steps[1].with.ref).toBe('c0fcaab5a3c0645225655f91a73f4dc2bc5bdfa6')
    expect(job.steps.slice(0, 2).every((step: { with: { 'persist-credentials': boolean } }) => step.with['persist-credentials'] === false)).toBe(true)
    const secretSteps = job.steps.filter((step: { env?: { CLOUDFLARE_API_TOKEN?: string } }) => step.env?.CLOUDFLARE_API_TOKEN)
    expect(secretSteps).toHaveLength(1)
    expect(secretSteps[0].run).toBe('node tooling/scripts/check-live-snippet-guard.mjs capture "$RUNNER_TEMP/snippet-guard"')
    const commands = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    expect(commands).not.toMatch(/--apply|deploy:|wrangler/)
    expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact')).with.path)
      .toBe('${{ runner.temp }}/snippet-guard/result.json')
  })

  it.concurrent('does not release or deploy production components when only proof tooling changes', () => {
    const files = ['scripts/check-live-snippet-guard.mjs', 'tests/snippet-live-guard.unit.test.ts', '.github/workflows/check_live_snippet_guard.yml']
    for (const component of ['capgo', 'cli', 'notifications'] as const) {
      expect(matchesComponent(component, files)).toBe(false)
      for (const file of files)
        expect(matchesComponent(component, [file])).toBe(false)
    }
    // Production snippet changes must keep their existing release behavior.
    expect(matchesComponent('capgo', ['scripts/snippet/deploy-snippets.ts'])).toBe(true)
    expect(matchesComponent('capgo', ['cloudflare_workers/snippet/index.js'])).toBe(true)
  })
})
