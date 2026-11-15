import type { McpToolContext } from '../supabase/functions/_backend/mcp/tools.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  appIdProblem,
  buildChecklist,
  buildPlan,
  checkReadiness,
  detectFramework,
  frameworkInfo,
  latestCapacitorRelease,
  parseVersion,
  recommendPlugins,
  resetCapacitorReleaseCache,
  suggestAppId,
} from '../supabase/functions/_backend/mcp/mobile_app.ts'
import { CHECKLIST, FRAMEWORK_IDS, MOBILE_FEATURES, SKILL_PURPOSES } from '../supabase/functions/_backend/mcp/mobile_app_catalog.ts'
import { handleJsonRpcMessage } from '../supabase/functions/_backend/mcp/protocol.ts'
import { MCP_TOOLS_BY_NAME } from '../supabase/functions/_backend/mcp/tools.ts'

const release = { latest: '8.6.2', next: '9.0.0-rc.0', source: 'npm' as const }
const mobileTools = ['capgo_plan_mobile_app', 'capgo_recommend_plugins', 'capgo_get_mobile_checklist', 'capgo_check_mobile_readiness']

function context(): McpToolContext & { calls: number } {
  const ctx = {
    calls: 0,
    caller: { userId: 'example-user', apikeyId: 1, apikeyName: 'Example key', apikeyExpiresAt: null },
    call: async () => {
      ctx.calls += 1
      return { ok: true, status: 200, data: null }
    },
  }
  return ctx
}

async function callTool(name: string, args: Record<string, unknown>, ctx = context()) {
  const response = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx)
  return z.object({
    result: z.object({
      content: z.array(z.object({ type: z.string(), text: z.string() })),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    }),
  }).parse(response).result
}

function npmFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

afterEach(() => {
  resetCapacitorReleaseCache()
  vi.unstubAllGlobals()
})

describe('latest Capacitor release', () => {
  it('reads the latest and next dist-tags from npm', async () => {
    const fetcher = npmFetch({ latest: '8.7.0', next: '9.0.0', 'latest-7': '7.6.10' })
    await expect(latestCapacitorRelease(fetcher, 1)).resolves.toEqual({ latest: '8.7.0', next: '9.0.0', source: 'npm' })
    expect(fetcher).toHaveBeenCalledWith('https://registry.npmjs.org/-/package/@capacitor%2fcore/dist-tags', expect.anything())
  })

  it('caches the npm answer for an hour', async () => {
    const fetcher = npmFetch({ latest: '8.7.0' })
    await latestCapacitorRelease(fetcher, 1_000)
    await latestCapacitorRelease(fetcher, 1_000 + 3_599_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await latestCapacitorRelease(fetcher, 1_000 + 3_600_001)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an HTTP error', npmFetch({ error: 'down' }, 503)],
    ['an invalid body', npmFetch({ latest: 'not-a-version' })],
    ['a network failure', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch],
  ])('falls back to the pinned release on %s without caching it', async (_label, fetcher) => {
    await expect(latestCapacitorRelease(fetcher, 1)).resolves.toMatchObject({ source: 'fallback', latest: expect.stringMatching(/^\d+\.\d+\.\d+$/) })
    const healthy = npmFetch({ latest: '8.7.0' })
    await expect(latestCapacitorRelease(healthy, 2)).resolves.toMatchObject({ source: 'npm', latest: '8.7.0' })
  })
})

describe('project facts', () => {
  it('parses hostile version ranges in linear time', () => {
    const started = performance.now()
    expect(parseVersion(`${'>='.repeat(50_000)}x`)).toBeNull()
    expect(performance.now() - started).toBeLessThan(200)
  })

  it.each([
    ['>=8.1', [8, 1, 0]],
    ['^8.4.0', [8, 4, 0]],
    ['~7.1', [7, 1, 0]],
    ['>=6.0.0', [6, 0, 0]],
    ['8', [8, 0, 0]],
    ['8.x', [8, 0, 0]],
    ['v22.12.0', [22, 12, 0]],
    ['latest', null],
    ['workspace:*', null],
    [undefined, null],
  ] as const)('parses %s', (range, expected) => {
    expect(parseVersion(range)).toEqual(expected)
  })

  it.each([
    [{ 'next': '^15.0.0', 'react': '^19.0.0' }, 'nextjs'],
    [{ nuxt: '^4.0.0', vue: '^3.5.0' }, 'nuxt'],
    [{ '@sveltejs/kit': '^2.0.0', 'vite': '^7.0.0' }, 'sveltekit'],
    [{ '@angular/core': '^20.0.0', '@ionic/angular': '^8.0.0' }, 'angular'],
    [{ '@react-router/dev': '^7.0.0', 'vite': '^7.0.0' }, 'react_router'],
    [{ '@remix-run/react': '^2.0.0' }, 'remix'],
    [{ astro: '^5.0.0', vite: '^7.0.0' }, 'astro'],
    [{ '@solidjs/start': '^1.0.0', 'vite': '^7.0.0' }, 'solidstart'],
    [{ '@builder.io/qwik-city': '^1.0.0', 'vite': '^7.0.0' }, 'qwik'],
    [{ gatsby: '^5.0.0' }, 'gatsby'],
    [{ 'react-scripts': '5.0.1' }, 'create_react_app'],
    [{ '@vue/cli-service': '^5.0.0' }, 'vue_cli'],
    [{ react: '^19.0.0', vite: '^7.0.0' }, 'vite'],
    [{ express: '^5.0.0' }, null],
  ] as const)('detects the framework from %j', (packages, expected) => {
    expect(detectFramework(packages)).toBe(expected)
  })

  it('knows a static output folder for every framework', () => {
    for (const id of FRAMEWORK_IDS)
      expect(frameworkInfo(id).webDir, id).toMatch(/\S/)
  })

  it.each([
    ['com.acme.shop', null],
    ['app.trailbuddy.mobile', null],
    ['com.acme-shop.app', /hyphens/],
    ['acme', /reverse-domain/],
    ['com.new.app', /Java keyword/],
    ['com.example.app', /placeholder/],
    ['com.1acme.app', /reverse-domain/],
  ])('validates app ID %s', (appId, problem) => {
    const result = appIdProblem(appId)
    if (problem)
      expect(result).toMatch(problem)
    else
      expect(result).toBeNull()
  })

  it('suggests an app ID from the website domain and flags placeholders', () => {
    expect(suggestAppId({ websiteUrl: 'https://www.acme-shop.com/pricing' })).toMatchObject({ app_id: 'com.acmeshop.app', source: 'website' })
    expect(suggestAppId({ websiteUrl: 'https://shop.acme.co.uk' })).toMatchObject({ app_id: 'uk.co.acme.shop', source: 'website' })
    expect(suggestAppId({ appId: 'com.acme.shop', websiteUrl: 'https://other.dev' })).toEqual({ app_id: 'com.acme.shop', source: 'input', warnings: [] })
    const placeholder = suggestAppId({ appName: 'Trail Buddy' })
    expect(placeholder).toMatchObject({ app_id: 'com.trailbuddy.app', source: 'placeholder' })
    expect(placeholder.warnings.join(' ')).toMatch(/reverse domain they control/)
    const invalid = suggestAppId({ appId: 'com.my-app', appName: 'My App' })
    expect(invalid.source).toBe('placeholder')
    expect(invalid.warnings[0]).toMatch(/hyphens/)
  })
})

describe('plugin recommendations', () => {
  it('maps every feature to real npm package names and docs', () => {
    const { plugins } = recommendPlugins({ features: MOBILE_FEATURES, includeBaseline: true })
    for (const plugin of plugins) {
      expect(plugin.package, plugin.feature).toMatch(/^@(capacitor|capgo)\/[a-z0-9-]+$/)
      expect(plugin.docs_url, plugin.package).toMatch(/^https:\/\/(capacitorjs\.com\/docs\/apis\/|capgo\.app\/docs\/plugins\/)/)
      expect(plugin.install, plugin.package).toBe(`npm install ${plugin.package}@latest`)
    }
    expect(new Set(plugins.map(plugin => plugin.package)).size).toBe(plugins.length)
    expect(new Set(plugins.map(plugin => plugin.feature))).toEqual(new Set(['baseline', ...MOBILE_FEATURES]))
  })

  it('keeps the feature details when a baseline plugin also serves a feature', () => {
    const { plugins } = recommendPlugins({ features: ['deep_links'] })
    const app = plugins.filter(plugin => plugin.package === '@capacitor/app')
    expect(app).toHaveLength(1)
    expect(app[0]).toMatchObject({ feature: 'deep_links', skill: 'capacitor-deep-linking' })
    expect(app[0].ios.capabilities.join(' ')).toContain('Associated Domains')
  })

  it('installs only missing packages with the project package manager', () => {
    const result = recommendPlugins({
      features: ['camera', 'in_app_purchases'],
      packageManager: 'bun',
      installed: { '@capacitor/app': '^8.0.0', '@capacitor/camera': '^8.0.0' },
    })
    expect(result.install_command).toBe('bun add @capacitor/splash-screen@latest @capacitor/keyboard@latest @capgo/native-purchases@latest')
    expect(result.ios_usage_keys).toEqual(['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription'])
    expect(result.plugins.find(plugin => plugin.package === '@capgo/native-purchases')).toMatchObject({
      publisher: 'capgo',
      checklist_ids: ['apple.in_app_purchase', 'google.play_billing'],
      ios: { capabilities: ['In-App Purchase'] },
    })
    expect(recommendPlugins({ features: ['haptics'], includeBaseline: false, installed: { '@capacitor/haptics': '^8.0.0' } }).install_command).toBeNull()
  })

  it('drops platform-specific configuration for platforms that are not shipped', () => {
    const [plugin] = recommendPlugins({ features: ['geolocation'], platforms: ['android'], includeBaseline: false }).plugins
    expect(plugin.ios).toEqual({ usage_keys: [], capabilities: [] })
    expect(plugin.android.permissions).toContain('android.permission.ACCESS_FINE_LOCATION')
  })
})

describe('mobile checklist', () => {
  it('has unique ids, known skills and resolvable cross references', () => {
    const ids = CHECKLIST.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of CHECKLIST) {
      expect(item.id.startsWith(`${item.topic === 'apple_review' ? 'apple' : item.topic === 'google_play' ? 'google' : item.topic}.`), item.id).toBe(true)
      if (item.skill)
        expect(Object.keys(SKILL_PURPOSES), item.id).toContain(item.skill)
    }
    const { plugins } = recommendPlugins({ features: MOBILE_FEATURES })
    for (const id of plugins.flatMap(plugin => plugin.checklist_ids))
      expect(ids, id).toContain(id)
  })

  it('includes conditional rules only for the traits passed', () => {
    const base = buildChecklist({ topics: ['apple_review'] })
    expect(base.items.map(item => item.id)).not.toContain('apple.account_deletion')
    expect(base.skipped_conditional.map(item => item.id)).toContain('apple.account_deletion')
    const withAccounts = buildChecklist({ topics: ['apple_review'], traits: ['accounts'] })
    expect(withAccounts.items.map(item => item.id)).toEqual(expect.arrayContaining(['apple.account_deletion', 'apple.demo_account']))
    expect(buildChecklist({ includeAllConditional: true }).skipped_conditional).toEqual([])
  })

  it('filters by platform and counts severities', () => {
    const android = buildChecklist({ platforms: ['android'], includeAllConditional: true })
    expect(android.items.some(item => item.topic === 'apple_review')).toBe(false)
    expect(android.items.map(item => item.id)).toContain('google.target_api')
    const total = android.counts.blocker + android.counts.required + android.counts.recommended
    expect(total).toBe(android.items.length)
    expect(android.skills.items.map(skill => skill.name)).toContain('safe-area-handling')
  })

  it('carries the design rules from the safe-area skill', () => {
    const design = buildChecklist({ topics: ['design'] }).items
    expect(design.find(item => item.id === 'design.viewport_fit_cover')).toMatchObject({ severity: 'blocker', skill: 'safe-area-handling' })
    expect(design.find(item => item.id === 'design.safe_areas')?.rule).toContain('100dvh')
  })
})

const readyProject = {
  platforms: ['ios', 'android'] as Array<'ios' | 'android'>,
  packages: {
    '@capacitor/core': '^8.6.2',
    '@capacitor/cli': '^8.6.2',
    '@capacitor/ios': '^8.6.2',
    '@capacitor/android': '^8.6.2',
    '@capgo/capacitor-updater': '^8.54.0',
    'vite': '^7.0.0',
    'vue': '^3.5.0',
  },
  capacitorConfig: { appId: 'app.trailbuddy.mobile', appName: 'Trail Buddy', webDir: 'dist' },
  project: {
    webDirHasIndexHtml: true,
    iosProject: true,
    androidProject: true,
    viewportMeta: 'width=device-width, initial-scale=1, viewport-fit=cover',
    safeAreaCss: true,
    serviceWorker: false,
    installPrompt: false,
    androidBackButton: true,
    externalLinksInBrowser: true,
    offlineState: true,
    localhostInBuild: false,
    iosUsageKeys: ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription'],
    iosPrivacyManifest: true,
    iosSceneDelegate: true,
    androidTargetSdk: 36,
    customAppIcon: true,
    splashScreen: true,
    notifyAppReady: true,
    nodeVersion: 'v22.12.0',
  },
  app: { features: ['camera', 'share'] as Array<'camera' | 'share'>, traits: ['accounts'] as Array<'accounts'>, accountDeletion: true, demoAccount: true },
}

describe('mobile readiness', () => {
  it('reports a complete project as ready with every check passing', () => {
    const result = checkReadiness(readyProject, release)
    expect(result.ready).toBe(true)
    expect(result.blocking).toEqual([])
    expect(result.checks.filter(check => check.status !== 'pass')).toEqual([])
  })

  it('names each failing rule with a fix', () => {
    const result = checkReadiness({
      ...readyProject,
      packages: { ...readyProject.packages, '@capacitor/core': '^7.4.0', '@capacitor/android': '^8.6.2' },
      capacitorConfig: { appId: 'com.example.app', appName: 'Trail Buddy', webDir: 'build', server: { url: 'https://acme.com', cleartext: true }, android: { adjustMarginsForEdgeToEdge: 'auto' } },
      project: { ...readyProject.project, viewportMeta: 'width=device-width, initial-scale=1', androidTargetSdk: 35, iosUsageKeys: [], notifyAppReady: false, nodeVersion: 'v20.10.0' },
      app: { ...readyProject.app, accountDeletion: false },
    }, release)
    expect(result.ready).toBe(false)
    expect(result.blocking).toEqual(expect.arrayContaining([
      'capacitor.latest_major',
      'capacitor.aligned',
      'tooling.node',
      'config.app_id',
      'config.no_server_url',
      'config.legacy_edge_to_edge',
      'design.viewport_fit_cover',
      'ios.usage_strings',
      'android.target_sdk',
      'capgo.notify_app_ready',
      'store.account_deletion',
    ]))
    const webDir = result.checks.find(check => check.id === 'config.web_dir')
    expect(webDir).toMatchObject({ status: 'warn', checklist_id: 'native.static_build' })
    expect(webDir?.detail).toContain('usually writes dist')
    for (const check of result.checks.filter(check => check.status === 'fail'))
      expect(check.fix, check.id).toMatch(/\S/)
  })

  it('lists the facts to inspect when blocker checks are unknown', () => {
    const result = checkReadiness({}, release)
    expect(result.ready).toBe(false)
    expect(result.summary.pass).toBe(0)
    expect(result.to_inspect.map(item => item.id)).toEqual(expect.arrayContaining(['capacitor.installed', 'config.present', 'design.viewport_fit_cover', 'android.target_sdk']))
    for (const item of result.to_inspect)
      expect(item.how_to_check, item.id).toMatch(/\S/)
  })

  it('trusts UI kits that pad safe areas and accepts either purpose key for calendars', () => {
    const result = checkReadiness({
      ...readyProject,
      packages: { ...readyProject.packages, '@ionic/vue': '^8.0.0' },
      project: { ...readyProject.project, safeAreaCss: false, iosUsageKeys: ['NSCalendarsWriteOnlyAccessUsageDescription'] },
      app: { features: ['calendar', 'share'] },
    }, release)
    expect(result.checks.find(check => check.id === 'design.safe_areas')).toMatchObject({ status: 'pass' })
    expect(result.checks.find(check => check.id === 'ios.usage_strings')).toMatchObject({ status: 'pass' })
  })

  it('flags Capacitor 8 before 8.5 for the Xcode 27 scene lifecycle', () => {
    const result = checkReadiness({ ...readyProject, packages: { ...readyProject.packages, '@capacitor/core': '^8.4.0' } }, release)
    expect(result.checks.find(check => check.id === 'capacitor.uiscene_ready')).toMatchObject({ status: 'warn' })
  })
})

describe('mobile app plan', () => {
  it('plans a Next.js migration with a static export, a Capacitor upgrade and the project package manager', () => {
    const plan = buildPlan({
      source: 'existing_web_app',
      packages: { 'next': '^15.3.0', 'react': '^19.0.0', '@capacitor/core': '^7.2.0', '@capacitor/cli': '^7.2.0' },
      websiteUrl: 'https://www.acme-shop.com',
      features: ['push_notifications', 'camera'],
      traits: ['accounts'],
      packageManager: 'pnpm',
      environment: { shell: true, os: 'linux', nodeVersion: 'v20.11.0' },
    }, release)
    expect(plan.framework).toMatchObject({ id: 'nextjs', detected_from: 'packages', web_dir: 'out', build_command: 'pnpm run build:mobile', static_export_required: true })
    expect(plan.capacitor).toMatchObject({ action: 'upgrade', latest_version: '8.6.2', installed_version: '^7.2.0', node_requirement: '>=22' })
    expect(plan.app).toEqual({ name: 'Acme Shop', app_id: 'com.acmeshop.app', app_id_source: 'website' })
    expect(plan.warnings.join(' ')).toMatch(/Node v20\.11\.0 is too old/)
    expect(plan.warnings.join(' ')).toMatch(/Xcode, which only runs on macOS/)
    const steps = plan.phases.flatMap(phase => phase.steps)
    expect(steps.find(item => item.id === 'static_output')?.detail).toContain('output: \'export\'')
    expect(steps.find(item => item.id === 'upgrade_capacitor')?.commands).toEqual(['pnpm add -D @capacitor/cli@latest', 'npx cap migrate'])
    expect(steps.map(item => item.id)).not.toContain('cap_init')
    expect(steps.find(item => item.id === 'install_plugins')?.commands).toEqual([
      'pnpm add @capacitor/app@latest @capacitor/splash-screen@latest @capacitor/keyboard@latest @capgo/capacitor-notifications@latest @capacitor/camera@latest',
      'pnpm run build:mobile && npx cap sync',
      'npx cap ls',
    ])
    // The design and plugin edits come after the Capacitor phase build, so running rebuilds first.
    expect(steps.find(item => item.id === 'run_locally')?.commands[0]).toBe('pnpm run build:mobile && npx cap sync')
    expect(plan.plugins.map(plugin => plugin.package)).toContain('@capgo/capacitor-updater')
    expect(plan.run_options.find(option => option.id === 'ios_simulator')?.available).toBe('no')
    expect(steps.find(item => item.id === 'check_tooling')?.commands).not.toContain('xcodebuild -version')
  })

  it('scaffolds a new Vite app with commands that run non-interactively', () => {
    const plan = buildPlan({
      source: 'new_app',
      appName: 'Trail Buddy',
      appId: 'app.trailbuddy.mobile',
      template: 'vue',
      environment: { shell: true, os: 'macos', xcode: true, androidSdk: false },
    }, release)
    expect(plan.phases.map(phase => phase.id)).toEqual(['prepare', 'scaffold', 'capacitor', 'native_ux', 'native_features', 'run', 'capgo', 'store'])
    const steps = plan.phases.flatMap(phase => phase.steps)
    expect(steps.find(item => item.id === 'create_vite_app')?.commands).toEqual([
      'npm create vite@latest trailbuddy -- --template vue-ts --no-interactive --no-immediate',
      'cd trailbuddy',
      'npm install',
    ])
    expect(steps.find(item => item.id === 'install_capacitor')?.commands).toEqual([
      'npm install @capacitor/core@latest @capacitor/ios@latest @capacitor/android@latest',
      'npm install -D @capacitor/cli@latest',
    ])
    expect(steps.find(item => item.id === 'cap_init')?.commands).toEqual(['npx cap init \'Trail Buddy\' app.trailbuddy.mobile --web-dir dist'])
    // npx cap add copies webDir, so the build runs before the first platform is added.
    const order = steps.map(item => item.id)
    expect(order.indexOf('build_web')).toBeLessThan(order.indexOf('add_ios'))
    expect(order.indexOf('add_android')).toBeLessThan(order.indexOf('sync'))
    expect(plan.run_options.find(option => option.id === 'ios_simulator')?.available).toBe('yes')
    expect(plan.run_options.find(option => option.id === 'android_emulator')?.available).toBe('no')
    expect(plan.run_options.find(option => option.id === 'capgo_cloud_simulator')?.mcp_tools).toContain('capgo_start_simulator')
    // Hosted builds use credentials stored on Capgo, so the user pushes them before the agent builds.
    const signing = steps.find(item => item.id === 'signing_credentials')!
    expect(signing).toMatchObject({ run_by: 'user' })
    expect(signing.commands).toEqual([
      'npx @capgo/cli@latest build init --platform ios',
      'npx @capgo/cli@latest build credentials push app.trailbuddy.mobile --platform ios',
      'npx @capgo/cli@latest build init --platform android',
      'npx @capgo/cli@latest build credentials push app.trailbuddy.mobile --platform android',
    ])
    expect(order.indexOf('signing_credentials')).toBeLessThan(order.indexOf('cloud_build'))
    expect(steps.find(item => item.id === 'cloud_build')).toMatchObject({ run_by: 'agent', mcp_tools: expect.arrayContaining(['capgo_request_build', 'capgo_start_build']) })
    // build zip archives the native folders as they are, so the updater wiring must be built and synced first.
    expect(steps.find(item => item.id === 'live_updates')?.commands).toEqual(['npm install @capgo/capacitor-updater@latest', 'npm run build && npx cap sync'])
    expect(steps.find(item => item.id === 'cloud_build')?.commands).toEqual([
      'npm run build && npx cap sync',
      'npx @capgo/cli@latest build zip app.trailbuddy.mobile --platform ios --json',
      'npx @capgo/cli@latest build zip app.trailbuddy.mobile --platform android --json',
    ])
  })

  it('runs the framework static build through build:mobile in every step', () => {
    const plan = buildPlan({ source: 'existing_web_app', packages: { nuxt: '^4.0.0', vue: '^3.5.0' }, appId: 'com.acme.shop', appName: 'Acme' }, release)
    expect(plan.framework).toMatchObject({ id: 'nuxt', build_command: 'npm run build:mobile', web_dir: '.output/public' })
    const steps = plan.phases.flatMap(phase => phase.steps)
    expect(steps[steps.findIndex(item => item.id === 'mobile_build_script')].files[0].change).toContain('"build:mobile": "nuxt generate"')
    expect(steps.findIndex(item => item.id === 'mobile_build_script')).toBeLessThan(steps.findIndex(item => item.id === 'static_output'))
    const commands = steps.flatMap(item => item.commands)
    expect(commands).toContain('npm run build:mobile && npx cap sync')
    expect(steps.map(item => item.id)).toContain('cap_init')
    expect(steps.map(item => item.id)).not.toContain('align_config')
    expect(commands).not.toContain('npm run build')
    expect(commands.filter(command => command.startsWith('npm run build:mobile')).length).toBeGreaterThanOrEqual(3)
  })

  it.each([
    ['current', '^8.6.2', ['npm install @capacitor/android@latest']],
    ['older', '^7.4.0', ['npm install @capacitor/android@latest']],
  ])('installs a missing platform package on a %s Capacitor app before adding the platform', (_label, version, commands) => {
    const plan = buildPlan({
      source: 'existing_web_app',
      packages: { 'vite': '^7.0.0', '@capacitor/core': version, '@capacitor/cli': version, '@capacitor/ios': version },
      appId: 'com.acme.shop',
      appName: 'Acme',
    }, release)
    const steps = plan.phases.flatMap(phase => phase.steps)
    const order = steps.map(item => item.id)
    expect(steps.find(item => item.id === 'install_platform_packages')?.commands).toEqual(commands)
    expect(order.indexOf('install_platform_packages')).toBeLessThan(order.indexOf('add_android'))
    expect(order).not.toContain('add_ios')
  })

  it('aligns an existing config webDir with the mobile build before syncing', () => {
    const plan = buildPlan({
      source: 'existing_web_app',
      packages: { 'nuxt': '^4.0.0', '@capacitor/core': '^8.6.2', '@capacitor/cli': '^8.6.2', '@capacitor/ios': '^8.6.2', '@capacitor/android': '^8.6.2' },
      appId: 'com.acme.shop',
      appName: 'Acme',
    }, release)
    const steps = plan.phases.flatMap(phase => phase.steps)
    const order = steps.map(item => item.id)
    expect(order).not.toContain('cap_init')
    const align = steps.find(item => item.id === 'align_config')!
    expect(align.files).toEqual([{ path: 'capacitor.config.ts (or .json)', change: 'webDir: \'.output/public\'' }])
    expect(align.detail).toContain('keep every other setting')
    expect(order.indexOf('align_config')).toBeLessThan(order.indexOf('sync'))
  })

  it('keeps app names and placeholder folders literal in shell commands', () => {
    const plan = buildPlan({ source: 'existing_web_app', packages: { '@angular/core': '^20.0.0' }, appName: 'Shop $HOME\'s `id`', appId: 'com.acme.shop' }, release)
    const steps = plan.phases.flatMap(phase => phase.steps)
    const init = steps.find(item => item.id === 'cap_init')!
    expect(init.commands).toEqual(['npx cap init \'Shop $HOME\'\\\'\'s `id`\' com.acme.shop --web-dir \'dist/<project>/browser\''])
    expect(init.files[0].change).toContain('appName: "Shop $HOME\'s `id`"')
    expect(steps.find(item => item.id === 'static_output')?.commands[1]).toBe('test -f \'dist/<project>/browser\'/index.html && echo "index.html OK"')
  })

  it('warns that a website URL alone cannot be packaged and switches to a handoff without a shell', () => {
    const plan = buildPlan({ source: 'website_only', websiteUrl: 'https://acme.com', environment: { shell: false } }, release)
    expect(plan.mode).toBe('handoff')
    expect(plan.warnings.join(' ')).toMatch(/need the source code/)
    expect(plan.warnings.join(' ')).toMatch(/handoff/)
    expect(plan.framework.id).toBe('unknown')
  })

  it('skips steps already done and points to readiness once the Capgo app exists', () => {
    const plan = buildPlan({
      source: 'existing_web_app',
      packages: { vite: '^7.0.0', react: '^19.0.0' },
      appId: 'com.acme.shop',
      appName: 'Acme',
      platforms: ['android'],
      existing: { capacitorConfig: true, android: true, capgoApp: true },
    }, release)
    const ids = plan.phases.flatMap(phase => phase.steps.map(item => item.id))
    expect(ids).not.toEqual(expect.arrayContaining(['cap_init']))
    expect(ids).not.toContain('add_android')
    expect(ids).not.toContain('add_ios')
    expect(plan.next_tool.name).toBe('capgo_check_mobile_readiness')
    expect(plan.run_options.map(option => option.id)).not.toContain('ios_simulator')
  })
})

describe('mobile app MCP tools', () => {
  it('answers through the protocol without calling the Capgo API and validates its output', async () => {
    vi.stubGlobal('fetch', npmFetch({ latest: '8.6.2', next: '9.0.0-rc.0' }))
    const ctx = context()
    const cases: Array<[string, Record<string, unknown>]> = [
      ['capgo_plan_mobile_app', { source: 'new_app', appName: 'Trail Buddy', appId: 'app.trailbuddy.mobile' }],
      ['capgo_recommend_plugins', { features: ['camera', 'social_login'] }],
      ['capgo_get_mobile_checklist', { topics: ['design'], platforms: ['ios'] }],
      ['capgo_check_mobile_readiness', readyProject],
    ]
    for (const [name, args] of cases) {
      const result = await callTool(name, args, ctx)
      expect(result.isError, `${name}: ${result.content[0].text.slice(0, 300)}`).toBeUndefined()
      expect(MCP_TOOLS_BY_NAME.get(name)!.outputSchema.safeParse(result.structuredContent).success, name).toBe(true)
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    }
    expect(ctx.calls).toBe(0)
  })

  it('is read-only and marks the tools that query npm as open-world', () => {
    for (const name of mobileTools) {
      const tool = MCP_TOOLS_BY_NAME.get(name)!
      expect(tool.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(tool.annotations.openWorldHint, name).toBe(name === 'capgo_plan_mobile_app' || name === 'capgo_check_mobile_readiness')
    }
  })

  it.each([
    ['capgo_plan_mobile_app', { source: 'clone_it' }],
    ['capgo_plan_mobile_app', { source: 'new_app', features: ['teleport'] }],
    ['capgo_recommend_plugins', { features: [] }],
    ['capgo_get_mobile_checklist', { topics: ['marketing'] }],
    ['capgo_check_mobile_readiness', { project: { androidTargetSdk: 'latest' } }],
  ])('rejects invalid arguments for %s with guidance', async (name, args) => {
    const result = await callTool(name, args)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'invalid_arguments', how_to_fix: { kind: 'fix_input' } })
  })

  it('keeps working when npm is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const result = await callTool('capgo_plan_mobile_app', { source: 'new_app' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ capacitor: { version_source: 'fallback' } })
    expect(JSON.stringify(result.structuredContent)).toContain('npm did not answer')
  })
})
