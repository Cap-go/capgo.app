import type { ModuleGraph } from '../scripts/visual-diff-graph'
import type { PageRoute } from '../scripts/visual-diff-plan'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { fileRoutePattern } from '../scripts/console-route-patterns'
import { stylesheetSource } from '../scripts/visual-diff-graph'
import {
  changedMessageKeys,
  changedRouteDefinitions,
  finalPage,
  fullCaptureReason,
  pageRoutes,
  parseRedirects,
  planSummary,
  resolveRoute,
  arrayElements,
  routeFingerprint,
  routesUsingKeys,
  shardCount,
  usesKey,
  visitedPaths,
} from '../scripts/visual-diff-plan'

function module(hash: string, imports: string[] = [], dynamicImports: string[] = [], code?: string) {
  return { hash, imports, dynamicImports, ...(code ? { code } : {}) }
}

function graph(overrides: Partial<ModuleGraph['modules']> = {}): ModuleGraph {
  return {
    root: '/repo',
    entries: ['index.html'],
    modules: {
      'index.html': module('html', ['src/main.ts']),
      'src/main.ts': module('main', ['\0vue-router/auto-routes', '\0virtual:generated-layouts', 'messages/en.json']),
      '\0vue-router/auto-routes': module('routes-v1', [], ['src/pages/a.vue', 'src/pages/b.vue']),
      '\0virtual:generated-layouts': module('layouts-v1', [], ['src/layouts/default.vue', 'src/layouts/naked.vue']),
      'messages/en.json': module('messages-v1'),
      'src/layouts/default.vue': module('default-layout', ['src/components/Sidebar.vue']),
      'src/layouts/naked.vue': module('naked-layout'),
      'src/components/Sidebar.vue': module('sidebar', [], [], `t('sidebar-title')`),
      'src/pages/a.vue': module('page-a', ['src/components/A.vue', 'src/components/Shared.vue']),
      'src/pages/b.vue': module('page-b', ['src/components/B.vue', 'src/components/Shared.vue'], ['src/components/LazyDialog.vue']),
      'src/components/A.vue': module('a', [], [], `t("a-title")`),
      'src/components/B.vue': module('b', [], [], 't(\'b-title\')'),
      'src/components/LazyDialog.vue': module('lazy', [], [], 't(`dialog-title`)'),
      'src/components/Shared.vue': module('shared'),
      ...overrides,
    } as ModuleGraph['modules'],
  }
}

const routeA: PageRoute = { page: 'src/pages/a.vue', pattern: '^/a/?$', params: 0, layouts: ['src/layouts/default.vue'] }
const routeB: PageRoute = { page: 'src/pages/b.vue', pattern: '^/b/?$', params: 0, layouts: ['src/layouts/default.vue'] }
const routeLogin: PageRoute = { page: 'src/pages/a.vue', pattern: '^/login/?$', params: 0, layouts: ['src/layouts/naked.vue'] }

describe('routeFingerprint', () => {
  const base = graph()

  it('ignores changes in other pages, including their lazy imports', () => {
    const head = graph({
      'src/components/B.vue': module('b-changed'),
      'src/components/LazyDialog.vue': module('lazy-changed'),
    })
    expect(routeFingerprint(head, routeA)).toBe(routeFingerprint(base, routeA))
    expect(routeFingerprint(head, routeB)).not.toBe(routeFingerprint(base, routeB))
  })

  it('flags every page that imports a changed shared component', () => {
    const head = graph({ 'src/components/Shared.vue': module('shared-changed') })
    expect(routeFingerprint(head, routeA)).not.toBe(routeFingerprint(base, routeA))
    expect(routeFingerprint(head, routeB)).not.toBe(routeFingerprint(base, routeB))
  })

  it('flags only the routes rendered in a changed layout', () => {
    const head = graph({ 'src/components/Sidebar.vue': module('sidebar-changed') })
    expect(routeFingerprint(head, routeA)).not.toBe(routeFingerprint(base, routeA))
    expect(routeFingerprint(head, routeLogin)).toBe(routeFingerprint(base, routeLogin))
  })

  it('flags every route when the app entry changes', () => {
    const head = graph({ 'src/main.ts': module('main-changed', ['\0vue-router/auto-routes', '\0virtual:generated-layouts', 'messages/en.json']) })
    expect(routeFingerprint(head, routeLogin)).not.toBe(routeFingerprint(base, routeLogin))
  })

  it('does not flag existing routes when a page is added or a message changes', () => {
    const head = graph({
      '\0vue-router/auto-routes': module('routes-v2', [], ['src/pages/a.vue', 'src/pages/b.vue', 'src/pages/c.vue']),
      'src/pages/c.vue': module('page-c'),
      'messages/en.json': module('messages-v2'),
    })
    expect(routeFingerprint(head, routeA)).toBe(routeFingerprint(base, routeA))
  })

  it('flags a route that now resolves to another page or layout', () => {
    expect(routeFingerprint(base, { ...routeA, page: 'src/pages/b.vue' })).not.toBe(routeFingerprint(base, routeA))
    expect(routeFingerprint(base, { ...routeA, layouts: ['src/layouts/naked.vue'] })).not.toBe(routeFingerprint(base, routeA))
  })
})

describe('message keys', () => {
  it('reports changed and removed keys, not added ones', () => {
    expect(changedMessageKeys(
      { 'a-title': 'A', 'b-title': 'B', 'nested': { kept: 'x', gone: 'y' } },
      { 'a-title': 'A2', 'b-title': 'B', 'nested': { kept: 'x' }, 'new-key': 'N' },
    )).toEqual(['a-title', 'nested.gone'])
  })

  it('maps a key to the routes whose code uses it, on either revision', () => {
    const base = graph()
    const head = graph({ 'src/components/A.vue': module('a') })
    const modules = (g: ModuleGraph) => new Map([
      ['a', new Set(Object.keys(g.modules).filter(key => key !== 'src/pages/b.vue' && !key.includes('/B.vue') && !key.includes('LazyDialog')))],
      ['b', new Set(['src/pages/b.vue', 'src/components/B.vue', 'src/components/LazyDialog.vue'])],
    ])
    const sides = [{ graph: base, modules: modules(base) }, { graph: head, modules: modules(head) }]
    expect([...routesUsingKeys(['a-title'], sides)!]).toEqual(['a'])
    expect([...routesUsingKeys(['dialog-title'], sides)!]).toEqual(['b'])
    expect([...routesUsingKeys(['sidebar-title'], sides)!]).toEqual(['a'])
  })

  it('finds keys built from a static prefix', () => {
    expect(usesKey('t(`plans-${name}`)', 'plans-pro')).toBe(true)
    expect(usesKey(`t('plans-' + name)`, 'plans-pro')).toBe(true)
    expect(usesKey('t(`${name}`)', 'plans-pro')).toBe(false)
    expect(usesKey('t(`other-${name}`)', 'plans-pro')).toBe(false)
  })

  it('keeps computed consumers when another route uses the key literally', () => {
    const base = graph({ 'src/components/B.vue': module('b', [], [], 't(`a-${suffix}`)') })
    const modules = new Map([
      ['a', new Set(['src/pages/a.vue', 'src/components/A.vue'])],
      ['b', new Set(['src/pages/b.vue', 'src/components/B.vue'])],
    ])
    expect([...routesUsingKeys(['a-title'], [{ graph: base, modules }])!].sort()).toEqual(['a', 'b'])
  })

  it('gives up when a key is never written literally (computed lookups)', () => {
    const base = graph()
    expect(routesUsingKeys(['plans.pro'], [{ graph: base, modules: new Map([['a', new Set(Object.keys(base.modules))]]) }])).toBeNull()
  })
})

describe('changedRouteDefinitions', () => {
  const source = (helper: string) => `async function helper(page) {\n  ${helper}\n}\n\nasync function other(page) {\n  await helper(page)\n}\n\nexport const visualDiffViewport = { width: 1440, height: 900 }\n\nexport const visualDiffRoutes = []\n`
  const routes = [
    { slug: 'plain', path: '/a', definition: JSON.stringify({ path: '/a', prepare: null }) },
    { slug: 'direct', path: '/b', definition: JSON.stringify({ path: '/b', prepare: 'page => helper(page)' }) },
    { slug: 'indirect', path: '/c', definition: JSON.stringify({ path: '/c', prepare: 'page => other(page)' }) },
  ]

  it('flags routes whose steps or helpers changed, transitively', () => {
    expect(changedRouteDefinitions({ source: source('await page.click()'), routes }, { source: source('await page.hover()'), routes })).toEqual(['direct', 'indirect'])
  })

  it('flags new and edited routes only', () => {
    const head = [...routes.slice(0, 2), { ...routes[2], definition: JSON.stringify({ path: '/c2' }) }, { slug: 'new', path: '/d', definition: '{}' }]
    expect(changedRouteDefinitions({ source: source('x'), routes }, { source: source('x'), routes: head })).toEqual(['indirect', 'new'])
  })

  it('flags every route when the viewport changes', () => {
    const head = source('x').replace('1440', '1280')
    expect(changedRouteDefinitions({ source: source('x'), routes }, { source: head, routes })).toEqual(['plain', 'direct', 'indirect'])
  })
})

describe('route list sources', () => {
  const config = (fixtures: string, extra = '') => `async function helper(page) {\n  await page.goto('/app/com.demo.app/getting-started')\n}\n\nexport const visualDiffRoutes = [\n  { slug: 'plain', path: '/a' },\n  ...[\n    ${fixtures}\n  ].map(({ slug, progress }) => ({ slug, path: '/apps', prepare: page => helper(page, progress) })),\n  ${extra}\n]\n`
  const routes = ['plain', 'mapped-a', 'mapped-b'].map(slug => ({ slug, path: slug === 'plain' ? '/a' : '/apps', definition: JSON.stringify({ path: '/apps', prepare: 'page => helper(page, progress)' }) }))
  const fixtures = `{ slug: 'mapped-a', progress: 'none' },\n    { slug: 'mapped-b', progress: 'ota' },`

  it('flags the routes of a mapped array when only a captured fixture value changes', () => {
    const head = fixtures.replace(`'ota'`, `'builder'`)
    expect(changedRouteDefinitions({ source: config(fixtures), routes }, { source: config(head), routes })).toEqual(['mapped-a', 'mapped-b'])
  })

  it('gives up on a changed list element that declares no slug', () => {
    expect(changedRouteDefinitions({ source: config(fixtures), routes }, { source: config(fixtures, '...extraRoutes,'), routes })).toBeNull()
  })

  it('follows page.goto() through helpers, and gives up on computed targets', () => {
    const [, mapped] = routes
    expect(visitedPaths(mapped, config(fixtures))).toEqual(['/apps', '/app/com.demo.app/getting-started'])
    expect(visitedPaths(mapped, config(fixtures).replace(`'/app/com.demo.app/getting-started'`, '`/app/${appId}`'))).toBeNull()
  })

  it('can attribute every route of the real config', () => {
    const source = readFileSync(join(import.meta.dirname, '../playwright/visual-diff.config.ts'), 'utf8')
    const elements = arrayElements(source.slice(source.indexOf('export const visualDiffRoutes')))
    expect(elements.length).toBeGreaterThan(0)
    // An element without a slug literal would make every config edit capture all routes.
    expect(elements.filter(element => !/\bslug:/.test(element))).toEqual([])
    for (const match of source.matchAll(/\.goto\(\s*([^,)]*)/g))
      expect(match[1].trim(), 'a computed page.goto() target makes its route always captured').toMatch(/^(['"`])[^'"`$]*\1$/)
  })
})

describe('stylesheetSource', () => {
  it('includes the versions of the packages a stylesheet loads', () => {
    const root = mkdtempSync(join(tmpdir(), 'visual-diff-css-'))
    try {
      writeFileSync(join(root, 'package.json'), '{}')
      mkdirSync(join(root, 'node_modules/daisyui'), { recursive: true })
      writeFileSync(join(root, 'node_modules/daisyui/package.json'), '{"name":"daisyui","version":"5.1.0"}')
      writeFileSync(join(root, 'style.css'), `@import 'tailwindcss' source(none);\n@plugin "daisyui/index.js" {}\n@import './local.css';\n`)
      const source = stylesheetSource(root, join(root, 'style.css'))
      expect(source).toContain('/* daisyui@5.1.0 */')
      expect(source).toContain('/* tailwindcss@missing */')
      expect(source).not.toContain('local.css@')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('fullCaptureReason', () => {
  it.each([
    ['public/fonts/inter.woff2', true],
    ['supabase/migrations/20260101_x.sql', true],
    ['supabase/functions/_backend/private/stats.ts', true],
    ['supabase/seed.sql', true],
    ['scripts/visual-diff.ts', true],
    ['playwright/support/consoleQuery.ts', true],
    ['.github/workflows/visual-diff.yml', true],
    ['supabase/tests/26_test.sql', false],
    ['supabase/functions/updates/index.ts', false],
    ['supabase/functions/_backend/emails/welcome.ts', false],
    ['playwright/e2e/apps.spec.ts', false],
    ['playwright/visual-diff.config.ts', false],
    ['src/pages/apps.vue', false],
    ['tests/foo.test.ts', false],
    ['supabase/migration_guide.md', false],
  ])('%s -> %s', (file, full) => {
    expect(Boolean(fullCaptureReason(file))).toBe(full)
  })
})

describe('pageRoutes and resolveRoute', () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-diff-plan-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const pages = {
    'src/pages/app/[app].channels.vue': '<template />',
    'src/pages/app/new.vue': '<template />',
    'src/pages/app/[app].vue': '<template />\n<route lang="yaml">\nmeta:\n  layout: app\n</route>\n',
    'src/pages/login.vue': '<template />',
    'src/pages/[...all].vue': '<template />\n<route lang="yaml">\nmeta:\n  layout: 404\n</route>\n',
  }
  for (const [file, content] of Object.entries(pages)) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  const routes = pageRoutes({ root, entries: [], modules: Object.fromEntries(Object.keys(pages).map(key => [key, module(key)])) })

  it('resolves URLs like the router: static before parameterized, catch-all last', () => {
    expect(resolveRoute(routes, '/app/new')?.page).toBe('src/pages/app/new.vue')
    expect(resolveRoute(routes, '/app/com.demo.app')?.page).toBe('src/pages/app/[app].vue')
    expect(resolveRoute(routes, '/app/com.demo.app/channels?tab=1')?.page).toBe('src/pages/app/[app].channels.vue')
    expect(resolveRoute(routes, '/app/com.demo.app/native')?.page).toBe('src/pages/[...all].vue')
  })

  it('assigns layouts from the route block and guest paths', () => {
    expect(resolveRoute(routes, '/app/com.demo.app')?.layouts).toEqual(['src/layouts/app.vue', 'src/layouts/default.vue'])
    expect(resolveRoute(routes, '/login')?.layouts).toEqual(['src/layouts/naked.vue'])
    expect(resolveRoute(routes, '/missing')?.layouts).toEqual(['src/layouts/404.vue'])
  })

  it('follows redirects to the page the router renders', () => {
    const redirects = parseRedirects([
      `{ path: '/app', redirect: '/app/new' },`,
      `{ path: '/app/:app/channel-list', redirect: redirectAppPath('/channels') },`,
      `{ path: '/app/:app/old', redirect: redirectAppPath('/channel-list') },`,
      '{ path: \'/p/:package\', redirect: to => `/app/${to.params.package}` },',
      `{\n  path: '/p/:package/logs',\n  redirect: (to) => {\n    return { path: '/x' }\n  },\n},`,
    ].join('\n'))
    expect(finalPage(routes, redirects, '/app')?.page).toBe('src/pages/app/new.vue')
    expect(finalPage(routes, redirects, '/app/com.demo.app/old?x=1')?.page).toBe('src/pages/app/[app].channels.vue')
    // Computed targets and catch-all URLs are only known at runtime.
    expect(finalPage(routes, redirects, '/p/com.demo.app')).toBeUndefined()
    expect(finalPage(routes, redirects, '/p/com.demo.app/logs')).toBeUndefined()
    expect(finalPage(routes, redirects, '/app/com.demo.app/native')).toBeUndefined()
  })

  it('treats [...all] as a catch-all instead of splitting it on its dots', () => {
    expect(fileRoutePattern(join(root, 'src/pages/[...all].vue'), join(root, 'src/pages'))).toBeNull()
  })
})

describe('shardCount and planSummary', () => {
  it('sizes the capture matrix to the work', () => {
    expect([0, 1, 12, 13, 95, 400].map(shardCount)).toEqual([0, 1, 1, 2, 6, 6])
  })

  it('explains the selection', () => {
    expect(planSummary({ mode: 'affected', reasons: [], routes: [], total: 95 })).toContain('No configured route can render differently')
    expect(planSummary({ mode: 'affected', reasons: [], routes: ['apps'], total: 95 })).toContain('Captured 1 of 95 routes')
    expect(planSummary({ mode: 'all', reasons: ['the backend, schema or seed data changed'], routes: ['a'], total: 1 })).toBe('Captured all 1 routes because the backend, schema or seed data changed.')
  })
})

describe('visual-diff workflow', () => {
  const workflow = parse(readFileSync(join(import.meta.dirname, '../.github/workflows/visual-diff.yml'), 'utf8'))
  const { plan, capture } = workflow.jobs
  const report = workflow.jobs['visual-diff']
  const run = (job: { steps: Array<{ run?: string }> }) => job.steps.map(step => step.run ?? '').join('\n')

  it('plans the merge commit against the base before capturing', () => {
    expect(run(plan)).toContain('visual-diff-plan.ts --base "${{ github.event.pull_request.base.sha }}" --head "${{ github.sha }}" --github-output')
    expect(capture.needs).toEqual(['check', 'plan'])
    expect(capture.if).toContain('needs.plan.outputs.count != \'0\'')
    expect(capture.strategy.matrix.shard).toBe('${{ fromJSON(needs.plan.outputs.shards) }}')
  })

  it('captures and compares only the planned routes', () => {
    expect(run(capture)).toContain('--routes "$ROUTES"')
    expect(run(capture)).toContain('--head "${{ github.sha }}"')
    expect(run(report)).toContain('visual-diff.ts diff --routes "$ROUTES"')
    expect(report.needs).toEqual(['check', 'plan', 'capture'])
    expect(run(report)).toContain('PLAN_RESULT')
  })
})
