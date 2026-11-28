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

function usesKey(code: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return new RegExp(`['"\`]${escaped}['"\`]`).test(code)
}

/** Routes whose modules mention a changed key; null when some key is never used literally. */
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
export function changedRouteDefinitions(base: RouteDefinitions, head: RouteDefinitions) {
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
  const viewportChanged = changed.has('visualDiffViewport')
  const baseBySlug = new Map(base.routes.map(route => [route.slug, route.definition]))
  return head.routes.filter(({ slug, definition }) => viewportChanged || baseBySlug.get(slug) !== definition
    || [...changed].some(name => new RegExp(`\\b${name}\\b`).test(definition))).map(route => route.slug)
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

    const affected = new Set(baseRoutes ? changedRouteDefinitions(baseRoutes, headRoutes) : all)
    const sides = [{ graph: baseGraph, modules: new Map<string, Set<string>>() }, { graph: headGraph, modules: new Map<string, Set<string>>() }]
    for (const route of headRoutes.routes) {
      const before = resolveRoute(basePages, route.path)
      const after = resolveRoute(headPages, route.path)
      if (!before || !after || routeFingerprint(baseGraph, before) !== routeFingerprint(headGraph, after))
        affected.add(route.slug)
      if (before)
        sides[0].modules.set(route.slug, routeModules(baseGraph, before))
      if (after)
        sides[1].modules.set(route.slug, routeModules(headGraph, after))
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
