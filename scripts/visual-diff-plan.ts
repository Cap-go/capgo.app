/**
 * Decides which visual diff routes a change can affect, so CI only screenshots those.
 *
 * The console is built at both revisions (a few seconds each) and each route is fingerprinted
 * from the modules it can load: the app entry, its page, its layouts, and everything they import,
 * stopping at other pages and layouts. A route whose fingerprint is identical renders from
 * identical code, so its screenshot cannot change unless something outside the bundle changed
 * (backend, seed data, public assets, the capture harness). Those changes capture every route.
 *
 *   bun scripts/visual-diff-plan.ts --base <sha> --head <sha> [--out plan.json] [--github-output]
 */
import type { GraphModule, ModuleGraph } from './visual-diff-graph'
import type { VisualDiffRoute } from '../playwright/visual-diff.config'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { pageRoutePattern, routeLayouts } from './console-route-patterns'

export interface PageRoute {
  page: string
  pattern: string
  params: number
  layouts: string[]
}

export interface VisualDiffPlan {
  mode: 'all' | 'affected'
  reasons: string[]
  routes: string[]
  total: number
}

const PAGE_KEY = /^src\/pages\/.+\.vue$/
const LAYOUT_KEY = /^src\/layouts\/[^/]+\.vue$/
const MESSAGES_KEY = /^messages\/[^/]+\.json$/

/** Paths outside the console bundle that still change what a screenshot shows. */
export function fullCaptureReason(file: string): string | undefined {
  if (file.endsWith('.md'))
    return undefined
  if (file.startsWith('public/'))
    return 'static assets in public/ changed'
  if (file.startsWith('supabase/')) {
    // Device-facing endpoints, test fixtures and auth email templates never render in the console.
    if (/^supabase\/(?:tests|templates)\//.test(file)
      || /^supabase\/functions\/(?:updates|updates_debug|stats|channel_self)\//.test(file)
      || file.startsWith('supabase/functions/_backend/emails/')) {
      return undefined
    }
    return 'the backend, schema or seed data changed'
  }
  if (file === '.github/workflows/visual-diff.yml'
    || /^scripts\/(?:visual-diff[^/]*|console-route-patterns|serve-backend-playwright|serve-stripe-emulator|playwright-stripe|supabase-worktree[^/]*|gotrue_password_sign_in)\.ts$/.test(file)
    || (file.startsWith('playwright/') && file !== 'playwright/visual-diff.config.ts' && !file.startsWith('playwright/e2e/') && file !== 'playwright/spec-durations.json')) {
    return 'the screenshot harness changed'
  }
  return undefined
}

export function pageRoutes(graph: ModuleGraph): PageRoute[] {
  const pagesDir = resolve(graph.root, 'src/pages')
  const routes: PageRoute[] = []
  for (const key of Object.keys(graph.modules)) {
    if (!PAGE_KEY.test(key))
      continue
    const file = resolve(graph.root, key)
    const pattern = pageRoutePattern(file, pagesDir)
    // Catch-all pages ([...all].vue) match whatever no other page matched.
    routes.push(pattern
      ? { page: key, pattern: pattern.source, params: pattern.params, layouts: routeLayouts(file, pattern.path).map(name => `src/layouts/${name}.vue`) }
      : { page: key, pattern: '^/.*$', params: Number.POSITIVE_INFINITY, layouts: routeLayouts(file, '/').map(name => `src/layouts/${name}.vue`) })
  }
  // Same order as the route preload: static paths win over parameterized ones.
  return routes.sort((a, b) => a.params - b.params || a.page.localeCompare(b.page))
}

export function resolveRoute(routes: PageRoute[], urlPath: string) {
  const pathname = urlPath.split(/[?#]/)[0] || '/'
  return routes.find(route => new RegExp(route.pattern, 'i').test(pathname))
}

export interface Redirect {
  pattern: RegExp
  params: string[]
  /** Target path with `:param` placeholders, or null when the router computes it. */
  target: string | null
}

/**
 * Redirects that src/main.ts registers (`{ path: '...', redirect: ... }`). Literal targets and
 * `redirectAppPath('<suffix>')` resolve statically; any other function target is computed.
 */
export function parseRedirects(mainSource: string): Redirect[] {
  return [...mainSource.matchAll(/\bpath:\s*['"`]([^'"`]+)['"`]\s*,\s*redirect:\s*([^\n]*)/g)].map(([, path, expression]) => {
    const segments = path.split('/').filter(Boolean)
    const params = segments.filter(segment => segment.startsWith(':')).map(segment => segment.slice(1).replace(/\(.*\)$/, ''))
    const source = segments.map(segment => segment.startsWith(':') ? '([^/]+)' : segment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('/')
    const literal = /^['"`]([^'"`$]+)['"`]/.exec(expression.trim())?.[1]
    const appPaths = [...expression.matchAll(/redirectAppPath\(\s*['"`]([^'"`$]*)['"`]\s*\)/g)]
    const target = literal ?? (appPaths.length === 1 && params.includes('app') ? `/app/:app${appPaths[0][1]}` : null)
    return { pattern: new RegExp(`^/${source}/?$`, 'i'), params, target }
  })
}

/**
 * The page a capture path renders after redirects, or undefined when that is only known at
 * runtime: a computed redirect target, or a URL only the catch-all page matches.
 */
export function finalPage(routes: PageRoute[], redirects: Redirect[], urlPath: string) {
  let pathname = urlPath.split(/[?#]/)[0] || '/'
  for (let hop = 0; hop < 5; hop++) {
    const redirect = redirects.find(candidate => candidate.pattern.test(pathname))
    if (!redirect)
      break
    if (!redirect.target)
      return undefined
    const values = redirect.pattern.exec(pathname)!.slice(1)
    pathname = redirect.params.reduce((path, name, index) => path.replace(`:${name}`, values[index]), redirect.target)
  }
  const page = resolveRoute(routes, pathname)
  return page && Number.isFinite(page.params) ? page : undefined
}

/** Modules a route can load: entry, page and layouts, not crossing into other pages or layouts. */
export function routeModules(graph: ModuleGraph, route: PageRoute) {
  const boundary = (key: string) => PAGE_KEY.test(key) || LAYOUT_KEY.test(key)
  const starts = [...graph.entries, route.page, ...route.layouts]
  const allowed = new Set(starts)
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length) {
    const key = stack.pop()!
    if (seen.has(key) || (boundary(key) && !allowed.has(key)))
      continue
    seen.add(key)
    const module = graph.modules[key]
    if (module)
      stack.push(...module.imports, ...module.dynamicImports)
  }
  return seen
}

/** The generated route and layout tables list every page, so adding one would touch all routes. */
function isRouteTable(module: GraphModule) {
  return module.dynamicImports.some(key => PAGE_KEY.test(key) || LAYOUT_KEY.test(key))
}

export function routeFingerprint(graph: ModuleGraph, route: PageRoute) {
  const parts = [`page=${route.page}`, `layouts=${route.layouts.join(',')}`]
  for (const key of [...routeModules(graph, route)].sort()) {
    const module = graph.modules[key]
    // Message catalogs are compared key by key (see changedMessageKeys).
    const hash = !module ? 'missing' : MESSAGES_KEY.test(key) || isRouteTable(module) ? 'tracked-separately' : module.hash
    parts.push(`${key}=${hash}`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

function flatten(value: unknown, prefix = '', out = new Map<string, string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatten(child, prefix ? `${prefix}.${key}` : key, out)
  }
  else {
    out.set(prefix, JSON.stringify(value))
  }
  return out
}

/**
 * Message keys whose text changed or that were removed. Added keys are ignored: only code that
 * uses them can show them, and that code changed too.
 */
export function changedMessageKeys(base: Record<string, unknown>, head: Record<string, unknown>) {
  const before = flatten(base)
  const after = flatten(head)
  return [...before].filter(([key, value]) => after.get(key) !== value).map(([key]) => key)
}

/**
 * Whether code can look up `key`: as a string literal, or built from a static prefix
 * (t(`plans-${name}`), t('plans-' + name)).
 */
export function usesKey(code: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  if (new RegExp(`['"\`]${escaped}['"\`]`).test(code))
    return true
  for (const match of code.matchAll(/`([^`$\\]{2,})\$\{|(['"])([^'"\\\n]{2,})\2\s*\+/g)) {
    if (key.startsWith(match[1] ?? match[3]))
      return true
  }
  return false
}

/** Routes whose modules can look up a changed key; null when no code anywhere can (a fully computed lookup). */
export function routesUsingKeys(keys: string[], sides: Array<{ graph: ModuleGraph, modules: Map<string, Set<string>> }>) {
  const affected = new Set<string>()
  for (const key of keys) {
    let found = false
    for (const { graph, modules } of sides) {
      for (const [slug, keys_] of modules) {
        if ([...keys_].some(moduleKey => graph.modules[moduleKey]?.code && usesKey(graph.modules[moduleKey].code!, key))) {
          affected.add(slug)
          found = true
        }
      }
      if (!found && Object.values(graph.modules).some(module => module.code && usesKey(module.code, key)))
        found = true
    }
    // Built at runtime (t(`plans.${name}`)): any route could show it.
    if (!found)
      return null
  }
  return affected
}

export interface RouteDefinitions {
  source: string
  routes: Array<{ slug: string, path: string, definition: string }>
}

export function serializeRoute(route: VisualDiffRoute) {
  return JSON.stringify({
    path: route.path,
    auth: route.auth ?? false,
    authCredentials: route.authCredentials ?? null,
    beforeNavigate: route.beforeNavigate?.toString() ?? null,
    prepare: route.prepare?.toString() ?? null,
  })
}

/** Top-level declarations of the config file, by name. */
function declarations(source: string) {
  const out = new Map<string, string>()
  const pattern = /^(?:export\s+)?(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gm
  const starts = [...source.matchAll(pattern)]
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length
    out.set(match[1] ?? match[2], source.slice(match.index, end).trim())
  })
  return out
}

/** Routes whose capture steps changed in playwright/visual-diff.config.ts, including helpers they call. */
/** The callback sources and fields of a serialized route, as plain text. */
function definitionText(definition: string) {
  return Object.values(JSON.parse(definition) as Record<string, unknown>).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n')
}

/** Top-level elements of the first array literal in `text`, skipping strings and comments. */
export function arrayElements(text: string) {
  const open = text.indexOf('[', text.indexOf('='))
  if (open === -1)
    return []
  const elements: string[] = []
  const closers: string[] = []
  let start = open + 1
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') {
      index = text.indexOf('\n', index)
      if (index === -1)
        break
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index) + 1
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      for (index++; index < text.length && text[index] !== char; index++) {
        if (text[index] === '\\')
          index++
      }
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      closers.push(char === '(' ? ')' : char === '[' ? ']' : '}')
      continue
    }
    if (closers.length && char === closers.at(-1)) {
      closers.pop()
      continue
    }
    if (closers.length === 0 && (char === ',' || char === ']')) {
      const element = text.slice(start, index).trim()
      if (element)
        elements.push(element)
      start = index + 1
      if (char === ']')
        break
    }
  }
  return elements
}

function slugsIn(text: string) {
  return [...text.matchAll(/\bslug:\s*['"`]([^'"`]+)['"`]/g)].map(match => match[1])
}

/**
 * Routes whose capture steps changed in playwright/visual-diff.config.ts, including helpers they
 * call. Returns null when a change cannot be tied to particular routes.
 */
export function changedRouteDefinitions(base: RouteDefinitions, head: RouteDefinitions): string[] | null {
  const baseDecls = declarations(base.source)
  const headDecls = declarations(head.source)
  const changed = new Set([...headDecls].filter(([name, text]) => name !== 'visualDiffRoutes' && baseDecls.get(name) !== text).map(([name]) => name))
  for (const name of baseDecls.keys()) {
    if (!headDecls.has(name))
      changed.add(name)
  }
  // A helper that calls a changed helper changed too.
  let grew = true
  while (grew) {
    grew = false
    for (const [name, text] of headDecls) {
      if (!changed.has(name) && name !== 'visualDiffRoutes' && [...changed].some(other => new RegExp(`\\b${other}\\b`).test(text))) {
        changed.add(name)
        grew = true
      }
    }
  }
  if (changed.has('visualDiffViewport'))
    return head.routes.map(route => route.slug)
  const baseBySlug = new Map(base.routes.map(route => [route.slug, route.definition]))
  const affected = new Set(head.routes.filter(({ slug, definition }) => baseBySlug.get(slug) !== definition
    || [...changed].some(name => new RegExp(`\\b${name}\\b`).test(definition))).map(route => route.slug))

  // Callbacks serialize without the values they capture (routes built by mapping an array of
  // fixtures), so also compare the source of each element of the route list, keyed by the slugs
  // it declares. A changed element without slugs cannot be tied to routes.
  const normalize = (text: string) => text.replace(/\s+/g, ' ')
  const baseElements = new Map(arrayElements(baseDecls.get('visualDiffRoutes') ?? '').map(element => [slugsIn(element).sort().join(','), normalize(element)]))
  for (const element of arrayElements(headDecls.get('visualDiffRoutes') ?? '')) {
    const slugs = slugsIn(element)
    if (baseElements.get(slugs.sort().join(',')) === normalize(element))
      continue
    if (slugs.length === 0)
      return null
    slugs.forEach(slug => affected.add(slug))
  }
  // Route lists declared outside visualDiffRoutes and spread into it.
  for (const name of changed) {
    for (const text of [headDecls.get(name) ?? '', baseDecls.get(name) ?? ''])
      slugsIn(text).forEach(slug => affected.add(slug))
  }
  return head.routes.map(route => route.slug).filter(slug => affected.has(slug))
}

/**
 * Paths a capture visits: its route, plus every page.goto() in its steps and the helpers they
 * call. Null when a goto target is computed, so the capture's page cannot be known in advance.
 */
export function visitedPaths(route: { path: string, definition: string }, source: string): string[] | null {
  const decls = declarations(source)
  const texts = [definitionText(route.definition)]
  const included = new Set<string>()
  for (let index = 0; index < texts.length; index++) {
    for (const [name, text] of decls) {
      if (name !== 'visualDiffRoutes' && !included.has(name) && new RegExp(`\\b${name}\\b`).test(texts[index])) {
        included.add(name)
        texts.push(text)
      }
    }
  }
  const paths = [route.path]
  for (const text of texts) {
    for (const match of text.matchAll(/\.goto\(\s*([^,)]*)/g)) {
      const literal = /^(['"`])([^'"`$]*)\1$/.exec(match[1].trim())
      if (!literal)
        return null
      paths.push(literal[2])
    }
  }
  return [...new Set(paths)]
}

export function shardCount(routes: number) {
  // Each capture runner spends ~4 minutes starting the stack, then ~9s per route.
  return routes === 0 ? 0 : Math.min(6, Math.ceil(routes / 12))
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, ...env } })
  if ((result.status ?? 1) !== 0)
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`)
  return result.stdout.trim()
}

// Same frontend environment as the capture build; any fixed values work since both sides match.
const buildEnv = { ENV: 'local', SUPA_URL: 'http://127.0.0.1:54321', SUPA_ANON: 'visual-diff-plan', API_DOMAIN: '127.0.0.1:54321/functions/v1', CAPTCHA_KEY: '' }

function buildGraph(checkout: string, out: string): ModuleGraph {
  run('bun', [resolve(import.meta.dirname, 'visual-diff-graph.ts'), '--out', out], checkout, buildEnv)
  return JSON.parse(readFileSync(out, 'utf8')) as ModuleGraph
}

function readMessages(root: string, key: string) {
  const file = resolve(root, key)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
}

async function readRouteDefinitions(root: string): Promise<RouteDefinitions> {
  const file = resolve(root, 'playwright/visual-diff.config.ts')
  const module = await import(pathToFileURL(file).href)
  const routes = (module.visualDiffRoutes as VisualDiffRoute[]).map(route => ({ slug: route.slug, path: route.path, definition: serializeRoute(route) }))
  return { source: readFileSync(file, 'utf8'), routes }
}

// @playwright/test refuses to load twice in one process, so each checkout's config is read by a
// child process running against that checkout's own dependencies.
function loadRoutes(root: string): RouteDefinitions {
  return JSON.parse(run('bun', [import.meta.filename, '--dump-routes'], root)) as RouteDefinitions
}

export async function planVisualDiff(options: { repoRoot: string, base: string, head: string, workDir: string }): Promise<VisualDiffPlan> {
  const { repoRoot, base, head, workDir } = options
  const headRoutes = loadRoutes(repoRoot)
  const all = headRoutes.routes.map(route => route.slug)
  const everything = (reasons: string[]): VisualDiffPlan => ({ mode: 'all', reasons, routes: all, total: all.length })

  const changedFiles = run('git', ['diff', '--name-only', base, head], repoRoot).split('\n').filter(Boolean)
  const reasons = [...new Set(changedFiles.map(fullCaptureReason).filter((reason): reason is string => Boolean(reason)))]
  if (reasons.length)
    return everything(reasons)

  const baseRoot = resolve(workDir, 'base-checkout')
  rmSync(baseRoot, { recursive: true, force: true })
  run('git', ['worktree', 'prune'], repoRoot)
  run('git', ['worktree', 'add', '--detach', '--force', baseRoot, base], repoRoot)
  try {
    run('bun', ['install', '--frozen-lockfile'], baseRoot)
    let baseGraph: ModuleGraph
    try {
      baseGraph = buildGraph(baseRoot, resolve(workDir, 'graph-base.json'))
    }
    catch (error) {
      return everything([`the base revision did not build (${error instanceof Error ? error.message : String(error)})`])
    }
    const headGraph = buildGraph(repoRoot, resolve(workDir, 'graph-head.json'))
    const basePages = pageRoutes(baseGraph)
    const headPages = pageRoutes(headGraph)
    let baseRoutes: RouteDefinitions | undefined
    try {
      baseRoutes = loadRoutes(baseRoot)
    }
    catch (error) {
      console.warn(`[visual-diff] could not read the base route definitions, capturing every route: ${error instanceof Error ? error.message : String(error)}`)
    }

    const definitions = baseRoutes ? changedRouteDefinitions(baseRoutes, headRoutes) : all
    if (!definitions)
      return everything(['a change to playwright/visual-diff.config.ts could not be tied to particular routes'])
    const affected = new Set(definitions)
    const sides = [{ graph: baseGraph, modules: new Map<string, Set<string>>() }, { graph: headGraph, modules: new Map<string, Set<string>>() }]
    const baseBySlug = new Map(baseRoutes?.routes.map(route => [route.slug, route]))
    const readMain = (root: string) => existsSync(resolve(root, 'src/main.ts')) ? readFileSync(resolve(root, 'src/main.ts'), 'utf8') : ''
    const baseRedirects = parseRedirects(readMain(baseRoot))
    const headRedirects = parseRedirects(readMain(repoRoot))
    for (const route of headRoutes.routes) {
      const baseRoute = baseBySlug.get(route.slug)
      const beforePaths = baseRoute && baseRoutes ? visitedPaths(baseRoute, baseRoutes.source) : null
      const afterPaths = visitedPaths(route, headRoutes.source)
      if (!beforePaths || !afterPaths) {
        affected.add(route.slug)
        continue
      }
      // A redirect or an unknown URL: the rendered page is decided at runtime, so always capture.
      const before = beforePaths.map(path => finalPage(basePages, baseRedirects, path))
      const after = afterPaths.map(path => finalPage(headPages, headRedirects, path))
      if (before.some(page => !page) || after.some(page => !page)) {
        affected.add(route.slug)
        continue
      }
      const fingerprint = (graph: ModuleGraph, pages: Array<PageRoute | undefined>) => pages.map(page => routeFingerprint(graph, page!)).join(',')
      if (fingerprint(baseGraph, before) !== fingerprint(headGraph, after))
        affected.add(route.slug)
      sides[0].modules.set(route.slug, new Set(before.flatMap(page => [...routeModules(baseGraph, page!)])))
      sides[1].modules.set(route.slug, new Set(after.flatMap(page => [...routeModules(headGraph, page!)])))
    }

    const catalogs = new Set(Object.keys(headGraph.modules).concat(Object.keys(baseGraph.modules)).filter(key => MESSAGES_KEY.test(key)))
    const keys = [...catalogs].flatMap(key => changedMessageKeys(readMessages(baseRoot, key), readMessages(repoRoot, key)))
    if (keys.length) {
      const usingKeys = routesUsingKeys([...new Set(keys)], sides)
      if (!usingKeys)
        return everything(['a changed message is looked up by a computed key'])
      usingKeys.forEach(slug => affected.add(slug))
    }

    const routes = all.filter(slug => affected.has(slug))
    return { mode: 'affected', reasons: [], routes, total: all.length }
  }
  finally {
    run('git', ['worktree', 'remove', '--force', baseRoot], repoRoot)
  }
}

export function planSummary(plan: VisualDiffPlan) {
  if (plan.mode === 'all')
    return `Captured all ${plan.total} routes because ${plan.reasons.join('; ')}.`
  if (plan.routes.length === 0)
    return `No configured route can render differently: the ${plan.total} routes load identical code before and after this change.`
  return `Captured ${plan.routes.length} of ${plan.total} routes, the ones whose code changed: ${plan.routes.map(slug => `\`${slug}\``).join(', ')}. The other routes load identical code before and after this change.`
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--dump-routes') {
    process.stdout.write(JSON.stringify(await readRouteDefinitions(process.cwd())))
    return
  }
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const base = value('--base')
  const head = value('--head') ?? 'HEAD'
  if (!base)
    throw new Error('Usage: visual-diff-plan.ts --base <sha> [--head <sha>] [--out plan.json] [--github-output]')
  const repoRoot = process.cwd()
  const out = resolve(value('--out') ?? '.context/visual-diff/plan.json')
  const workDir = dirname(out)
  mkdirSync(workDir, { recursive: true })

  let plan: VisualDiffPlan
  try {
    plan = await planVisualDiff({ repoRoot, base, head, workDir })
  }
  catch (error) {
    // A planning bug must not hide a visual change: fall back to capturing everything.
    console.error(error instanceof Error ? error.stack : error)
    const all = loadRoutes(repoRoot).routes.map(route => route.slug)
    plan = { mode: 'all', reasons: ['the route planner failed (see the plan job log)'], routes: all, total: all.length }
  }
  const summary = planSummary(plan)
  writeFileSync(out, JSON.stringify({ ...plan, summary }, null, 2))
  console.log(`[visual-diff] ${summary}`)

  if (args.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    const shards = shardCount(plan.routes.length)
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `routes=${plan.routes.join(',')}`,
      `count=${plan.routes.length}`,
      `shard_total=${shards}`,
      `shards=${JSON.stringify(Array.from({ length: shards }, (_, index) => index + 1))}`,
      `summary=${summary}`,
      '',
    ].join('\n'))
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  })
}
