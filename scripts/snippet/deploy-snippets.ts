import type { BuiltSnippet } from './catalog.ts'
import { createHash } from 'node:crypto'
import { SNIPPET_ZONE_ID, validateSnippets } from './catalog.ts'
import { includeCustomDomains, validateCustomDomains } from './custom-domains.ts'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
interface Rule { snippet_name: string, expression: string, enabled: boolean, description?: string }
interface Envelope<T> { success: boolean, result: T, result_info?: { total_pages?: number } }
interface Options {
  token: string
  snippets: readonly BuiltSnippet[]
  customDomains?: readonly string[]
  apply?: boolean
  fetcher?: Fetcher
  log?: (message: string) => void
}

export async function deploySnippets({ token, snippets, customDomains, apply = false, fetcher = fetch, log = console.log }: Options) {
  if (!token)
    throw new Error('Set CLOUDFLARE_API_TOKEN with Zone / Snippets / Edit for capgo.app')
  validateSnippets(snippets)
  if (customDomains) validateCustomDomains(customDomains)
  const base = `https://api.cloudflare.com/client/v4/zones/${SNIPPET_ZONE_ID}/snippets`
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw new Error('Cloudflare snippets request could not be completed') })
    if (!response.ok)
      throw new Error(`Cloudflare snippets request failed (HTTP ${response.status})`)
    return response
  }
  async function json<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
    const data = await (await request(path, init)).json().catch(() => { throw new Error('Invalid Cloudflare snippets response') }) as Envelope<T>
    if (data.success !== true)
      throw new Error('Cloudflare snippets API returned success=false')
    return data
  }
  async function content(name: string): Promise<string> {
    const form = await (await request(`/${name}/content`)).formData().catch(() => { throw new Error('Invalid Cloudflare snippet content response') })
    const files: File[] = []
    form.forEach((value) => {
      if (typeof value !== 'string')
        files.push(value)
    })
    if (files.length !== 1)
      throw new Error(`Expected one JavaScript module for ${name}; reconcile the live source before deploying`)
    return files[0].text()
  }
  async function rules(): Promise<Rule[]> {
    const { result } = await json<Rule[] | null>('/snippet_rules')
    if (result !== null && !Array.isArray(result))
      throw new Error('Invalid snippet rules response')
    const list = result ?? []
    if (list.some(rule => typeof rule.snippet_name !== 'string' || typeof rule.expression !== 'string'
      || typeof rule.enabled !== 'boolean' || (rule.description != null && typeof rule.description !== 'string')))
      throw new Error('Invalid snippet rules response')
    for (const { name } of snippets) {
      if (!list.some(rule => rule.snippet_name === name))
        throw new Error(`Missing routing rule for ${name}; provision its rule before enabling CI deployment`)
    }
    // Never log or commit the expressions: they may include customer domains.
    return list.map(({ snippet_name, expression, enabled, description }) => ({
      snippet_name, expression, enabled, description: description ?? '',
    }))
  }

  const liveNames: string[] = []
  for (let page = 1; ; page++) {
    if (page > 100)
      throw new Error('Snippet inventory exceeded pagination limit')
    const data = await json<{ snippet_name: string }[]>(`?page=${page}&per_page=25`)
    if (!Array.isArray(data.result))
      throw new Error('Invalid snippet inventory response')
    liveNames.push(...data.result.map(snippet => snippet.snippet_name))
    if (data.result.length < 25 || page >= (data.result_info?.total_pages ?? Infinity))
      break
  }
  if (JSON.stringify([...liveNames].sort()) !== JSON.stringify(snippets.map(snippet => snippet.name).sort()))
    throw new Error('Live snippet inventory differs from the catalog; reconcile it before deploying (no writes made)')
  const beforeRules = await rules()
  const desiredRules = beforeRules.map(rule => ({ ...rule }))
  let addedDomains = 0
  if (customDomains) {
    const pluginRules = desiredRules.filter(rule => rule.snippet_name === 'plugin_load_balancer')
    if (pluginRules.length !== 1 || !pluginRules[0].enabled)
      throw new Error('Expected one enabled plugin_load_balancer rule before reconciling custom domains')
    const plan = includeCustomDomains(pluginRules[0].expression, customDomains)
    pluginRules[0].expression = plan.expression
    addedDomains = plan.added
    log(`Production custom domains: ${customDomains.length} checked, ${addedDomains} missing from snippet routing`)
  }
  // Read all modules before the first write, so inventory or format failures cannot partially deploy.
  const current = await Promise.all(snippets.map(snippet => content(snippet.name)))
  for (const [index, { name, code }] of snippets.entries()) {
    if (current[index] === code) {
      log(`${name}: unchanged`)
      continue
    }
    const hash = createHash('sha256').update(code).digest('hex')
    log(`${name}: ${apply ? 'uploading' : 'would upload'} ${new TextEncoder().encode(code).length} bytes sha256:${hash}`)
    if (!apply)
      continue
    const form = new FormData()
    form.append('files', new File([code], 'snippet.js', { type: 'application/javascript+module' }))
    form.append('metadata', JSON.stringify({ main_module: 'snippet.js' }))
    await json(`/${name}`, { method: 'PUT', body: form })
    if (await content(name) !== code)
      throw new Error(`Uploaded content verification failed for ${name}`)
    log(`${name}: verified`)
  }
  if (JSON.stringify(await rules()) !== JSON.stringify(beforeRules))
    throw new Error('Snippet routing rules changed during deployment; inspect the concurrent change')
  if (addedDomains && apply) {
    await json('/snippet_rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: desiredRules }) })
    if (JSON.stringify(await rules()) !== JSON.stringify(desiredRules))
      throw new Error('Custom-domain routing verification failed; inspect the live snippet rules')
    log(`Custom-domain routing: ${addedDomains} hosts added and verified`)
  }
  log(`${apply ? 'Deployed' : 'Dry run checked'} ${snippets.length} snippets; ${addedDomains && apply ? 'custom-domain routing verified' : 'routing rules unchanged'}`)
}
