import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { matchesComponent } from '../scripts/release-scope'
import { MAX_SNIPPET_BYTES, SNIPPETS, SNIPPET_ZONE_ID } from '../scripts/snippet/catalog'
import { CUSTOM_DOMAIN_PLUGIN_EXPRESSION } from '../scripts/snippet/custom-domains'
import { deploySnippets } from '../scripts/snippet/deploy-snippets'

const snippets = [{ name: 'one', code: 'export default { fetch() {} }\n' }, { name: 'two', code: 'export default { fetch() { return 1 } }\n' }]

function fixture(definitions = snippets) {
  const live = new Map(definitions.map(snippet => [snippet.name, 'export default {}\n']))
  const rules = definitions.map(({ name }) => ({ snippet_name: name, enabled: true, expression: '(http.host eq "example.com")', description: `Rule for ${name}` }))
  const calls: { url: string, init?: RequestInit }[] = []
  const writes: string[] = []
  const ruleWrites: unknown[] = []
  let failUpload = false
  let corruptUpload = false
  let multiModule = false
  let ruleDrift = false
  let corruptRules = false
  let failRules = false
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    expect(url.startsWith(`https://api.cloudflare.com/client/v4/zones/${SNIPPET_ZONE_ID}/snippets`)).toBe(true)
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    expect(init?.redirect).toBe('error')
    const path = new URL(url).pathname.split('/snippets')[1]
    const ok = (result: unknown) => Response.json({ success: true, result })
    if (path === '')
      return ok([...live.keys()].map(snippet_name => ({ snippet_name })))
    if (path === '/snippet_rules') {
      if (init?.method === 'PUT') {
        expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
        const body = JSON.parse(init.body as string)
        ruleWrites.push(body.rules)
        if (failRules)
          return new Response('private provider response', { status: 403 })
        if (!corruptRules)
          rules.splice(0, rules.length, ...body.rules)
        return ok(rules)
      }
      expect(init?.method).toBeUndefined()
      return ok(ruleDrift && writes.length ? [...rules].reverse() : rules)
    }
    const name = path.split('/')[1]
    if (path.endsWith('/content')) {
      const form = new FormData()
      form.append('files', new File([live.get(name)!], 'main.js'))
      if (multiModule)
        form.append('files', new File(['export {}'], 'helper.js'))
      return new Response(form)
    }
    expect(init?.method).toBe('PUT')
    writes.push(name)
    if (failUpload)
      return new Response('private error body must not be logged', { status: 403 })
    const form = init!.body as FormData
    expect(form.get('metadata')).toBe(JSON.stringify({ main_module: 'snippet.js' }))
    live.set(name, corruptUpload ? 'wrong code' : await (form.get('files') as File).text())
    return ok({ snippet_name: name })
  })
  return { definitions, live, rules, calls, writes, ruleWrites, fetcher, setFail: () => { failUpload = true }, setCorrupt: () => { corruptUpload = true }, setMulti: () => { multiModule = true }, setDrift: () => { ruleDrift = true }, setCorruptRules: () => { corruptRules = true }, setFailRules: () => { failRules = true } }
}

function run(f: ReturnType<typeof fixture>, apply = true) {
  return deploySnippets({ token: 'test-token', snippets: f.definitions, apply, fetcher: f.fetcher, log: () => {} })
}

describe('snippet release deployment', () => {
  it.concurrent('uploads each module, verifies it, and never changes routing rules', async () => {
    const f = fixture()
    await run(f)
    expect(f.writes).toEqual(['one', 'two'])
    expect([...f.live.values()]).toEqual(snippets.map(snippet => snippet.code))
    await run(f)
    expect(f.writes).toEqual(['one', 'two'])
  })

  it.concurrent('defaults to reading the complete inventory without any writes', async () => {
    const f = fixture()
    await deploySnippets({ token: 'test-token', snippets, fetcher: f.fetcher, log: () => {} })
    expect(f.writes).toEqual([])
    expect(f.calls.filter(call => call.url.endsWith('/content'))).toHaveLength(2)
  })

  it.concurrent.each(['missing', 'extra', 'rule', 'modules'] as const)('fails before any upload for %s drift', async (kind) => {
    const f = fixture()
    if (kind === 'missing') f.live.delete('two')
    if (kind === 'extra') f.live.set('unmanaged', 'export default {}')
    if (kind === 'rule') f.rules.pop()
    if (kind === 'modules') f.setMulti()
    await expect(run(f)).rejects.toThrow()
    expect(f.writes).toEqual([])
  })

  it.concurrent('stops on failed uploads without exposing the provider body', async () => {
    const f = fixture()
    f.setFail()
    await expect(run(f)).rejects.toThrow('Cloudflare snippets request failed (HTTP 403)')
    expect(f.writes).toEqual(['one'])
  })

  it.concurrent('fails on unsuccessful API envelopes', async () => {
    await expect(deploySnippets({ token: 'test', snippets, fetcher: async () => Response.json({ success: false }) })).rejects.toThrow('success=false')
  })

  it.concurrent('fails when upload readback differs', async () => {
    const f = fixture()
    f.setCorrupt()
    await expect(run(f)).rejects.toThrow('verification failed')
    expect(f.writes).toEqual(['one'])
  })

  it.concurrent('detects concurrent routing changes without overwriting them', async () => {
    const f = fixture()
    f.setDrift()
    await expect(run(f)).rejects.toThrow('routing rules changed')
  })

  it.concurrent.each([
    { label: 'empty catalog', invalid: [], error: 'nonempty with unique names' },
    { label: 'empty module', invalid: [{ name: 'one', code: '' }], error: 'must contain 1–' },
    { label: 'invalid name', invalid: [{ name: '../other', code: 'export {}' }], error: 'Invalid snippet name' },
    { label: 'oversized module', invalid: [{ name: 'one', code: 'é'.repeat(MAX_SNIPPET_BYTES) }], error: 'must contain 1–' },
    { label: 'duplicate names', invalid: [snippets[0], snippets[0]], error: 'nonempty with unique names' },
  ])('rejects $label before network access', async ({ invalid, error }) => {
    const f = fixture()
    await expect(deploySnippets({ token: 'test', snippets: invalid, fetcher: f.fetcher })).rejects.toThrow(error)
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it.concurrent('builds all three production snippets within the provider limit', () => {
    const output = execFileSync('bun', ['scripts/snippet/build-snippets.ts'], { encoding: 'utf8' })
    for (const snippet of SNIPPETS)
      expect(output).toContain(`${snippet.name}:`)
    expect(SNIPPETS).toHaveLength(3)
  })

  it.concurrent('deploys only stable tested release code after backend success with the CI credential', () => {
    const workflow = parse(readFileSync('.github/workflows/build_and_deploy.yml', 'utf8'))
    const job = workflow.jobs.deploy_snippets
    expect(workflow.on.push.tags).toEqual(['capgo-[0-9]*'])
    expect(job.if).toContain("needs.changes.outputs.is_alpha != 'true'")
    expect(job.if).toContain("needs.changes.result == 'success'")
    expect(job.if).toContain("!contains(needs.*.result, 'failure')")
    expect(job.if).toContain("!contains(needs.*.result, 'cancelled')")
    expect(job.needs).toEqual(expect.arrayContaining(['deploy_api', 'deploy_files', 'deploy_plugin_regions', 'deploy_gotrue_worker', 'supabase_deploy']))
    const step = job.steps.find((step: { run?: string }) => step.run === 'bun run deploy:snippets')
    // eslint-disable-next-line no-template-curly-in-string
    expect(step.env.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(step.env.SUPABASE_ACCESS_TOKEN).toBeUndefined()
    expect(step.env.SUPABASE_PROJECT_ID_PROD).toBeUndefined()
    expect(matchesComponent('capgo', ['scripts/snippet/deploy-snippets.ts'])).toBe(true)
  })
})

describe('production custom domains in snippet deployment', () => {
  const create = () => fixture([{ ...snippets[0], name: 'plugin_load_balancer' }, snippets[1]])

  it.concurrent('adds the stable predicate after code verification, preserving all existing branches and other rules', async () => {
    const f = create()
    f.rules[1].enabled = false
    const other = structuredClone(f.rules[1])
    await run(f)
    expect(f.ruleWrites).toHaveLength(1)
    expect(f.rules[0].expression).toBe(`((http.host eq "example.com")) or ${CUSTOM_DOMAIN_PLUGIN_EXPRESSION}`)
    expect(f.rules[0].description).toBe('Rule for plugin_load_balancer')
    expect(f.rules[1]).toEqual(other)
    const rulePut = f.calls.findIndex(call => call.url.endsWith('/snippet_rules') && call.init?.method === 'PUT')
    for (const { name } of f.definitions) {
      const modulePut = f.calls.findIndex(call => call.url.endsWith(`/snippets/${name}`) && call.init?.method === 'PUT')
      const readback = f.calls.findIndex((call, index) => index > modulePut && call.url.endsWith(`/snippets/${name}/content`))
      expect(modulePut).toBeGreaterThanOrEqual(0)
      expect(readback).toBeGreaterThan(modulePut)
      expect(readback).toBeLessThan(rulePut)
    }
    expect(f.calls.slice(rulePut).filter(call => call.url.endsWith('/content'))).toEqual([])
    await run(f)
    expect(f.ruleWrites).toHaveLength(1)
  })

  it.concurrent('dry run reports the missing predicate without rewriting code or rules', async () => {
    const f = create()
    const messages: string[] = []
    const currentLength = f.rules[0].expression.length
    await deploySnippets({ token: 'test-token', snippets: f.definitions, fetcher: f.fetcher, log: message => messages.push(message) })
    expect(f.writes).toEqual([])
    expect(f.ruleWrites).toEqual([])
    expect(messages).toContain(`Custom-domain routing expression: current=${currentLength} planned=${currentLength + CUSTOM_DOMAIN_PLUGIN_EXPRESSION.length + 6} limit=4096`)
    expect(messages.join('\n')).not.toContain('example.com')
  })

  it.concurrent.each(['disabled', 'duplicate', 'missing', 'oversized'] as const)('rejects %s plugin rules before uploading code', async (kind) => {
    const f = create()
    if (kind === 'disabled') f.rules[0].enabled = false
    if (kind === 'duplicate') f.rules.push({ ...f.rules[0] })
    if (kind === 'missing') f.rules.shift()
    if (kind === 'oversized') f.rules[0].expression = `http.request.uri.path eq "${'x'.repeat(4090)}"`
    await expect(run(f)).rejects.toThrow()
    expect(f.writes).toEqual([])
    expect(f.ruleWrites).toEqual([])
  })

  it.concurrent.each(['upload', 'concurrent'] as const)('does not change routing after %s failure', async (kind) => {
    const f = create()
    if (kind === 'upload') f.setFail()
    if (kind === 'concurrent') f.setDrift()
    await expect(run(f)).rejects.toThrow()
    expect(f.ruleWrites).toEqual([])
  })

  it.concurrent.each(['provider', 'readback'] as const)('fails on routing %s failure', async (kind) => {
    const f = create()
    if (kind === 'provider') f.setFailRules()
    if (kind === 'readback') f.setCorruptRules()
    await expect(run(f)).rejects.toThrow(kind === 'provider' ? 'HTTP 403' : 'routing verification failed')
    expect(f.ruleWrites).toHaveLength(1)
  })
})
