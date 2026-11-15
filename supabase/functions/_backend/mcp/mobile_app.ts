import { z } from 'zod'
import type { AppTrait, ChecklistSpec, ChecklistTopic, FrameworkId, FrameworkInfo, MobileFeature, NewAppTemplate, Platform, PluginSpec, Severity, SkillName } from './mobile_app_catalog.ts'
import { BASELINE_PLUGINS, CHECKLIST, CHECKLIST_TOPICS, FRAMEWORKS, PLATFORMS, PLUGINS, SKILLS_INSTALL_COMMAND, skillRef } from './mobile_app_catalog.ts'

/**
 * Web app to mobile app guidance for the hosted MCP.
 *
 * The hosted server cannot read the user's files. The agent reports what it found in the project and
 * these pure functions return a typed plan, plugin picks, checklists and a readiness verdict. The rules
 * come from Capgo's public Capacitor skills (https://github.com/Cap-go/capgo-skills); every item names
 * the skill an agent can load for the full procedure.
 */

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const
export type PackageManager = typeof PACKAGE_MANAGERS[number]

// ---------------------------------------------------------------------------
// Capacitor release
// ---------------------------------------------------------------------------

/** Checked against npm on 2026-11-15. Used only when the registry does not answer. */
export const CAPACITOR_FALLBACK_RELEASE = { latest: '8.6.2', next: '9.0.0-rc.0' } as const
const CAPACITOR_DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@capacitor%2fcore/dist-tags'
const RELEASE_CACHE_MS = 3_600_000
const RELEASE_TIMEOUT_MS = 2_000

export interface CapacitorRelease {
  latest: string
  next: string | null
  source: 'npm' | 'fallback'
}

// A failed lookup is remembered briefly so an npm outage does not add the timeout to every call.
const FALLBACK_CACHE_MS = 60_000

// Only settled values are cached. An in-flight fetch is not shared: on Workers a promise whose I/O
// belongs to another request never settles for the waiter (see utils/invalids_ip.ts).
let releaseCache: { at: number, ttl: number, value: CapacitorRelease } | undefined

/** Latest @capacitor/core from npm, cached per isolate. Never throws: falls back to the pinned release. */
export async function latestCapacitorRelease(fetcher: typeof fetch = fetch, now = Date.now()): Promise<CapacitorRelease> {
  if (releaseCache && now - releaseCache.at < releaseCache.ttl)
    return releaseCache.value
  try {
    const response = await fetcher(CAPACITOR_DIST_TAGS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) })
    if (!response.ok)
      throw new Error(`npm registry returned ${response.status}`)
    const tags = z.object({ latest: z.string(), next: z.string().optional() }).parse(await response.json())
    if (parseVersion(tags.latest) === null)
      throw new Error('npm registry returned an invalid version')
    const value: CapacitorRelease = { latest: tags.latest, next: tags.next ?? null, source: 'npm' }
    releaseCache = { at: now, ttl: RELEASE_CACHE_MS, value }
    return value
  }
  catch {
    const value: CapacitorRelease = { latest: CAPACITOR_FALLBACK_RELEASE.latest, next: CAPACITOR_FALLBACK_RELEASE.next, source: 'fallback' }
    releaseCache = { at: now, ttl: FALLBACK_CACHE_MS, value }
    return value
  }
}

/** Test hook: forget the cached npm answer. */
export function resetCapacitorReleaseCache() {
  releaseCache = undefined
}

/** Lowest version a package.json range allows, e.g. ^8.4.0 -> [8, 4, 0]. Null for tags, URLs and workspaces. */
export function parseVersion(range: string | undefined): [number, number, number] | null {
  if (!range)
    return null
  const match = /^\s*[\^~>=v]*\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(range)
  if (!match)
    return null
  const part = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : 0)
  return [Number(match[1]), part(match[2]), part(match[3])]
}

export function nodeRequirement(capacitorMajor: number): string {
  // Capacitor 8 needs Node 22; Capacitor 9 raises it to Node 24.
  return capacitorMajor >= 9 ? '>=24' : '>=22'
}

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

const FRAMEWORKS_BY_ID = new Map(FRAMEWORKS.map(framework => [framework.id, framework]))

export function frameworkInfo(id: FrameworkId): FrameworkInfo {
  return FRAMEWORKS_BY_ID.get(id) ?? FRAMEWORKS_BY_ID.get('unknown')!
}

export function detectFramework(packages: Record<string, string> | undefined): FrameworkId | null {
  if (!packages)
    return null
  const names = new Set(Object.keys(packages))
  for (const framework of FRAMEWORKS) {
    if (framework.packages.some(name => names.has(name)))
      return framework.id
  }
  return null
}

const UI_KIT_PACKAGES = ['@ionic/react', '@ionic/vue', '@ionic/angular', '@ionic/core', 'konsta', 'framework7']

function handlesSafeAreas(packages: Record<string, string> | undefined): string | null {
  if (!packages)
    return null
  return UI_KIT_PACKAGES.find(name => name in packages) ?? null
}

// ---------------------------------------------------------------------------
// Package manager commands
// ---------------------------------------------------------------------------

export function addCommand(pm: PackageManager, packages: string[], dev = false): string {
  const list = packages.join(' ')
  switch (pm) {
    case 'pnpm':
      return `pnpm add ${dev ? '-D ' : ''}${list}`
    case 'yarn':
      return `yarn add ${dev ? '-D ' : ''}${list}`
    case 'bun':
      return `bun add ${dev ? '-d ' : ''}${list}`
    default:
      return `npm install ${dev ? '-D ' : ''}${list}`
  }
}

function runScript(pm: PackageManager, script: string): string {
  if (pm === 'yarn')
    return `yarn ${script}`
  return `${pm} run ${script}`
}

function createViteCommand(pm: PackageManager, directory: string, template: string): string {
  const flags = `--template ${template} --no-interactive --no-immediate`
  switch (pm) {
    case 'pnpm':
      return `pnpm create vite ${directory} ${flags}`
    case 'yarn':
      return `yarn create vite ${directory} ${flags}`
    case 'bun':
      return `bun create vite ${directory} ${flags}`
    default:
      return `npm create vite@latest ${directory} -- ${flags}`
  }
}

/** POSIX single-quote a shell argument so names like `Shop $HOME` stay literal. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll('\'', `'\\''`)}'`
}

function installCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn install' : `${pm} install`
}

// ---------------------------------------------------------------------------
// App identity
// ---------------------------------------------------------------------------

const APP_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/i
const PLACEHOLDER_APP_IDS = new Set(['com.example.app', 'io.ionic.starter', 'com.company.app', 'com.capacitorjs.app'])
const JAVA_KEYWORDS = new Set(['abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'])

/**
 * Capacitor (and Android) need Java package segments, so no hyphens. Apple bundle identifiers allow
 * only letters, digits, hyphens and periods, so underscores only work for Android-only apps.
 */
export function appIdProblem(appId: string, platforms: readonly Platform[] = PLATFORMS): string | null {
  if (!APP_ID_PATTERN.test(appId))
    return 'Use reverse-domain segments of letters and digits, each starting with a letter, such as com.yourcompany.yourapp. Capacitor and Android reject hyphens.'
  if (platforms.includes('ios') && appId.includes('_'))
    return 'iOS bundle identifiers allow only letters, digits, hyphens and periods: remove the underscores (Capacitor rejects hyphens, so use letters and digits only).'
  const keyword = appId.split('.').find(segment => JAVA_KEYWORDS.has(segment.toLowerCase()))
  if (keyword)
    return `The segment "${keyword}" is a Java keyword, which Android does not allow in an applicationId.`
  if (PLACEHOLDER_APP_IDS.has(appId.toLowerCase()))
    return `${appId} is a template placeholder. Use a reverse domain you control: stores reject duplicates and the ID cannot change after the first release.`
  return null
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!cleaned)
    return 'app'
  return /^\d/.test(cleaned) ? `app${cleaned}` : cleaned
}

export function suggestAppId(input: { appId?: string, websiteUrl?: string, appName?: string, platforms?: readonly Platform[] }) {
  const platforms = input.platforms?.length ? input.platforms : PLATFORMS
  const warnings: string[] = []
  if (input.appId) {
    const problem = appIdProblem(input.appId, platforms)
    if (!problem)
      return { app_id: input.appId, source: 'input' as const, warnings }
    warnings.push(`appId ${input.appId}: ${problem}`)
  }
  if (input.websiteUrl) {
    try {
      const host = new URL(input.websiteUrl).hostname.replace(/^www\./, '')
      const labels = host.split('.').filter(Boolean).map(slug)
      if (labels.length >= 2) {
        const reversed = [...labels].reverse()
        const segments = reversed.length === 2 ? [...reversed, input.appName ? slug(input.appName) : 'app'] : reversed
        const candidate = segments.map(segment => (JAVA_KEYWORDS.has(segment) ? `${segment}app` : segment)).join('.')
        if (!appIdProblem(candidate, platforms)) {
          warnings.push(`Suggested ${candidate} from the website domain. Confirm it with the user: the app ID is permanent once published.`)
          return { app_id: candidate, source: 'website' as const, warnings }
        }
      }
    }
    catch {
      warnings.push('websiteUrl could not be parsed to suggest an app ID.')
    }
  }
  const name = input.appName ? slug(input.appName) : 'myapp'
  warnings.push(`com.${name}.app is a placeholder. Ask the user for a reverse domain they control before running npx cap init: the app ID is permanent once published.`)
  return { app_id: `com.${name}.app`, source: 'placeholder' as const, warnings }
}

// ---------------------------------------------------------------------------
// Native features and plugins
// ---------------------------------------------------------------------------

export interface PluginRecommendation {
  feature: MobileFeature | 'baseline'
  package: string
  publisher: 'capacitor' | 'capgo'
  purpose: string
  install: string
  docs_url: string
  ios: { usage_keys: string[], capabilities: string[] }
  android: { permissions: string[] }
  notes: string[]
  store_notes: string[]
  checklist_ids: string[]
  skill: string | null
  alternatives: string[]
}

function toRecommendation(feature: PluginRecommendation['feature'], spec: PluginSpec, pm: PackageManager, platforms: readonly Platform[]): PluginRecommendation {
  return {
    feature,
    package: spec.package,
    publisher: spec.publisher,
    purpose: spec.purpose,
    install: addCommand(pm, [`${spec.package}@latest`]),
    docs_url: spec.docsUrl,
    ios: platforms.includes('ios') ? { usage_keys: spec.iosUsageKeys ?? [], capabilities: spec.iosCapabilities ?? [] } : { usage_keys: [], capabilities: [] },
    android: { permissions: platforms.includes('android') ? spec.androidPermissions ?? [] : [] },
    notes: spec.notes ?? [],
    store_notes: spec.storeNotes ?? [],
    checklist_ids: spec.checklist ?? [],
    skill: spec.skill ?? null,
    alternatives: spec.alternatives ?? [],
  }
}

export function recommendPlugins(input: { features: readonly MobileFeature[], platforms?: readonly Platform[], packageManager?: PackageManager, includeBaseline?: boolean, installed?: Record<string, string> }) {
  const pm = input.packageManager ?? 'npm'
  const platforms = input.platforms?.length ? input.platforms : PLATFORMS
  const plugins: PluginRecommendation[] = []
  const add = (feature: PluginRecommendation['feature'], spec: PluginSpec) => {
    const index = plugins.findIndex(plugin => plugin.package === spec.package)
    const recommendation = toRecommendation(feature, spec, pm, platforms)
    if (index === -1)
      plugins.push(recommendation)
    else if (plugins[index].feature === 'baseline')
      plugins[index] = recommendation // The feature entry carries the capabilities and notes the baseline one lacks.
  }
  if (input.includeBaseline !== false) {
    for (const spec of BASELINE_PLUGINS)
      add('baseline', spec)
  }
  for (const feature of new Set(input.features)) {
    for (const spec of PLUGINS[feature])
      add(feature, spec)
  }
  const missing = plugins.filter(plugin => !(input.installed && plugin.package in input.installed)).map(plugin => `${plugin.package}@latest`)
  const usageKeys = [...new Set(plugins.flatMap(plugin => plugin.ios.usage_keys))]
  return {
    plugins,
    install_command: missing.length ? addCommand(pm, missing) : null,
    sync_command: 'npx cap sync',
    ios_usage_keys: usageKeys,
    notes: [
      'Plugin majors must match the app\'s Capacitor major; @latest matches the latest Capacitor release. On an older Capacitor major, install the matching tag (for example @latest-7) or upgrade the app first.',
      'Write each iOS purpose string as a specific, honest sentence about why the app needs the access; a missing key crashes the app on first use.',
      'Request permissions at the moment of use and handle denied, limited and unavailable states in the UI.',
      'After installing, run npx cap sync and npx cap ls: every plugin must be listed for each platform. Then test on a real device.',
    ],
  }
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

const CHECKLIST_BY_ID = new Map(CHECKLIST.map(item => [item.id, item]))

export interface ChecklistItem {
  id: string
  topic: ChecklistTopic
  severity: Severity
  platforms: Platform[]
  title: string
  rule: string
  how_to_check: string[]
  fix: string
  skill: string | null
  docs_url: string | null
}

function toChecklistItem(spec: ChecklistSpec): ChecklistItem {
  return {
    id: spec.id,
    topic: spec.topic,
    severity: spec.severity,
    platforms: [...spec.platforms],
    title: spec.title,
    rule: spec.rule,
    how_to_check: spec.check,
    fix: spec.fix,
    skill: spec.skill ?? null,
    docs_url: spec.docsUrl ?? null,
  }
}

export function buildChecklist(input: { topics?: readonly ChecklistTopic[], platforms?: readonly Platform[], traits?: readonly AppTrait[], includeAllConditional?: boolean }) {
  const topics = new Set(input.topics?.length ? input.topics : CHECKLIST_TOPICS)
  const platforms = input.platforms?.length ? input.platforms : PLATFORMS
  const traits = new Set(input.traits ?? [])
  const items = CHECKLIST
    .filter(item => topics.has(item.topic))
    .filter(item => item.platforms.some(platform => platforms.includes(platform)))
    .filter(item => input.includeAllConditional || !item.when || item.when.some(trait => traits.has(trait)))
    .map(toChecklistItem)
  const counts = { blocker: 0, required: 0, recommended: 0 }
  for (const item of items)
    counts[item.severity] += 1
  const skippedConditional = CHECKLIST
    .filter(item => topics.has(item.topic) && item.when && !item.when.some(trait => traits.has(trait)) && !input.includeAllConditional)
    .filter(item => item.platforms.some(platform => platforms.includes(platform)))
    .map(item => ({ id: item.id, applies_when: item.when ?? [] }))
  const skills = [...new Set(items.flatMap(item => (item.skill ? [item.skill as SkillName] : [])))].map(skillRef)
  return { items, counts, skipped_conditional: skippedConditional, skills: { install_command: SKILLS_INSTALL_COMMAND, items: skills } }
}

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

export const CHECK_STATUSES = ['pass', 'fail', 'warn', 'unknown', 'not_applicable'] as const
export type CheckStatus = typeof CHECK_STATUSES[number]

export interface ReadinessInput {
  platforms?: Platform[]
  packages?: Record<string, string>
  capacitorConfig?: {
    appId?: string
    appName?: string
    webDir?: string
    server?: Record<string, unknown>
    ios?: Record<string, unknown>
    android?: Record<string, unknown>
    plugins?: Record<string, unknown>
  }
  project?: {
    webDirHasIndexHtml?: boolean
    iosProject?: boolean
    androidProject?: boolean
    viewportMeta?: string
    safeAreaCss?: boolean
    serviceWorker?: boolean
    installPrompt?: boolean
    androidBackButton?: boolean
    externalLinksInBrowser?: boolean
    offlineState?: boolean
    localhostInBuild?: boolean
    iosUsageKeys?: string[]
    iosPrivacyManifest?: boolean
    iosSceneDelegate?: boolean
    androidTargetSdk?: number
    customAppIcon?: boolean
    splashScreen?: boolean
    notifyAppReady?: boolean
    nodeVersion?: string
  }
  app?: {
    features?: MobileFeature[]
    traits?: AppTrait[]
    accountDeletion?: boolean
    signInWithApple?: boolean
    nativeIap?: boolean
    demoAccount?: boolean
  }
}

export interface ReadinessCheck {
  id: string
  status: CheckStatus
  severity: Severity
  title: string
  detail: string
  fix: string | null
  how_to_check: string | null
  checklist_id: string | null
  skill: string | null
}

type CheckDraft = Omit<ReadinessCheck, 'how_to_check' | 'checklist_id' | 'skill'> & { how_to_check?: string, checklist_id?: string, skill?: SkillName }

/** A check decided by one observed boolean fact; undefined means the agent did not inspect it. */
interface FactRule {
  id: string
  severity: Severity
  title: string
  value: boolean | undefined
  /** Fact value that passes. */
  pass: boolean
  /** Status when the fact does not pass. Default fail. */
  miss?: 'fail' | 'warn'
  /** Detail when the check passes or is unknown. */
  ok: string
  /** Detail when the check does not pass. */
  bad: string
  fix: string
  checklist_id?: string
  how_to_check?: string
  skill?: SkillName
}

class ReadinessReport {
  readonly checks: ReadinessCheck[] = []

  add(check: CheckDraft) {
    const item = check.checklist_id ? CHECKLIST_BY_ID.get(check.checklist_id) : undefined
    this.checks.push({
      ...check,
      how_to_check: check.status === 'unknown' ? (check.how_to_check ?? item?.check[0] ?? null) : null,
      checklist_id: check.checklist_id ?? null,
      skill: check.skill ?? item?.skill ?? null,
    })
  }

  fact(rule: FactRule) {
    const { value, pass, miss = 'fail', ok, bad, fix, ...rest } = rule
    const missed = value !== undefined && value !== pass
    let status: CheckStatus = 'pass'
    if (value === undefined)
      status = 'unknown'
    else if (missed)
      status = miss
    this.add({ ...rest, status, detail: missed ? bad : ok, fix: missed ? fix : null })
  }
}

function capacitorChecks(report: ReadinessReport, packages: Record<string, string> | undefined, platforms: readonly Platform[], release: CapacitorRelease) {
  const title = '@capacitor/core is installed'
  if (!packages) {
    report.add({ id: 'capacitor.installed', status: 'unknown', severity: 'blocker', title, detail: 'Pass packages (dependencies and devDependencies from package.json) to check Capacitor.', fix: null, how_to_check: 'Read package.json dependencies and devDependencies.' })
    return null
  }
  const core = parseVersion(packages['@capacitor/core'])
  if (!core) {
    report.add({ id: 'capacitor.installed', status: 'fail', severity: 'blocker', title, detail: '@capacitor/core is missing or uses a version range without a number.', fix: 'Install @capacitor/core@latest and @capacitor/cli@latest (dev), then npx cap init.' })
    return null
  }
  report.add({ id: 'capacitor.installed', status: 'pass', severity: 'blocker', title, detail: `@capacitor/core ${packages['@capacitor/core']}.`, fix: null })
  const [major, minor] = core
  const latestMajor = parseVersion(release.latest)?.[0] ?? 8
  report.fact({
    id: 'capacitor.latest_major',
    severity: 'required',
    title: 'Capacitor is on the latest major',
    value: major >= latestMajor,
    pass: true,
    ok: `Capacitor ${major} matches the latest release ${release.latest}.`,
    bad: `Capacitor ${major} is installed; the latest release is ${release.latest}.`,
    fix: `Upgrade every @capacitor/* package to ${latestMajor} (npx cap migrate after installing @capacitor/cli@latest) and the plugins to their matching major.`,
    skill: 'capacitor-app-upgrades',
  })
  if (major === 8 && minor < 5)
    report.add({ id: 'capacitor.uiscene_ready', status: 'warn', severity: 'required', title: 'Capacitor 8.5+ for Xcode 27', detail: 'Xcode 27 builds (required by Apple from April 2027) need the UIScene lifecycle that Capacitor 8.5 adds.', fix: 'Upgrade to the latest Capacitor 8 and apply the 8.5 UIScene project changes.', skill: 'capacitor-app-upgrades' })
  const majors = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android']
    .filter(name => packages[name])
    .map(name => [name, parseVersion(packages[name])?.[0]] as const)
  report.fact({
    id: 'capacitor.aligned',
    severity: 'required',
    title: 'Capacitor packages share one major',
    value: majors.every(([, value]) => value === undefined || value === major),
    pass: true,
    ok: 'All installed @capacitor packages use the same major.',
    bad: `Different majors: ${majors.map(([name, value]) => `${name}@${value ?? '?'}`).join(', ')}.`,
    fix: 'Install the same major for @capacitor/core, cli, ios and android.',
  })
  if (!packages['@capacitor/cli'])
    report.add({ id: 'capacitor.cli', status: 'fail', severity: 'blocker', title: '@capacitor/cli is installed', detail: '@capacitor/cli is missing, so npx cap commands will not match the project version.', fix: 'Install @capacitor/cli@latest as a dev dependency.' })
  for (const platform of platforms) {
    const name = `@capacitor/${platform}`
    report.fact({ id: `capacitor.${platform}_package`, severity: 'blocker', title: `${name} is installed`, value: Boolean(packages[name]), pass: true, ok: `${name} ${packages[name]}.`, bad: `${name} is missing.`, fix: `Install ${name}@latest, then npx cap add ${platform}.` })
  }
  return core
}

function nodeCheck(report: ReadinessReport, core: [number, number, number] | null, release: CapacitorRelease, nodeVersion: string | undefined) {
  const needed = nodeRequirement(Math.max(core?.[0] ?? parseVersion(release.latest)?.[0] ?? 8, 8))
  const minimum = Number(needed.replace('>=', ''))
  const node = parseVersion(nodeVersion)
  report.fact({
    id: 'tooling.node',
    severity: 'blocker',
    title: `Node ${needed}`,
    value: node ? node[0] >= minimum : undefined,
    pass: true,
    ok: node ? `Node ${nodeVersion} is installed; Capacitor needs ${needed}.` : `Capacitor needs Node ${needed}.`,
    bad: `Node ${nodeVersion} is installed; Capacitor needs ${needed}.`,
    fix: `Install Node ${minimum} LTS or newer.`,
    how_to_check: 'node --version',
  })
}

function webDirCheck(report: ReadinessReport, webDir: string | undefined, packages: Record<string, string> | undefined) {
  const expected = detectFramework(packages)
  const expectedDir = expected ? frameworkInfo(expected).webDir : null
  const hint = expectedDir ? ` (usually ${expectedDir})` : ''
  const base = { id: 'config.web_dir', severity: 'blocker' as const, title: 'webDir points at the static build output', checklist_id: 'native.static_build' }
  if (!webDir) {
    report.add({ ...base, status: 'fail', detail: 'webDir is missing.', fix: `Set webDir to the folder that contains the built index.html${hint}.` })
    return
  }
  const matches = !expectedDir || expectedDir.includes('<') || webDir.replace(/^\.\//, '').replace(/\/$/, '') === expectedDir
  if (matches)
    report.add({ ...base, status: 'pass', detail: `webDir ${webDir}.`, fix: null })
  else
    report.add({ ...base, status: 'warn', detail: `webDir is ${webDir} but ${frameworkInfo(expected!).name} usually writes ${expectedDir}.`, fix: `Set webDir to the folder that contains the built index.html${hint}.` })
}

function configChecks(report: ReadinessReport, input: ReadinessInput, platforms: readonly Platform[]) {
  const config = input.capacitorConfig
  if (!config) {
    report.add({ id: 'config.present', status: 'unknown', severity: 'blocker', title: 'capacitor.config is valid', detail: 'Pass capacitorConfig (appId, appName, webDir, server, ios, android, plugins from capacitor.config.*).', fix: null, how_to_check: 'Read capacitor.config.ts/json, or run npx cap config --json when available.' })
    return
  }
  const problem = config.appId ? appIdProblem(config.appId, platforms) : 'appId is missing.'
  report.fact({ id: 'config.app_id', severity: 'blocker', title: 'App ID is a permanent reverse domain', value: problem === null, pass: true, ok: `appId ${config.appId}.`, bad: problem ?? '', fix: 'Choose the final reverse-domain app ID with the user and set appId (and the native bundle identifiers) before the first store upload.' })
  report.fact({ id: 'config.app_name', severity: 'required', title: 'App name is set', value: Boolean(config.appName), pass: true, ok: `appName ${config.appName}.`, bad: 'appName is missing.', fix: 'Set appName (the name under the icon).' })
  webDirCheck(report, config.webDir, input.packages)
  const serverUrl = typeof config.server?.url === 'string' ? config.server.url : undefined
  report.fact({ id: 'config.no_server_url', severity: 'blocker', title: 'No remote server.url in the release config', value: !serverUrl, pass: true, ok: 'The app loads its bundled web assets.', bad: `server.url is ${serverUrl}: the app loads a remote page instead of its bundle.`, fix: 'Remove server.url (and server.cleartext) from capacitor.config for release builds.', checklist_id: 'native.bundled_assets' })
  if (config.server?.cleartext === true)
    report.add({ id: 'config.cleartext', status: 'warn', severity: 'required', title: 'Cleartext HTTP disabled', detail: 'server.cleartext allows plain HTTP traffic, which is meant for live reload only.', fix: 'Remove server.cleartext from the release config.' })
  if (platforms.includes('android') && config.android && 'adjustMarginsForEdgeToEdge' in config.android)
    report.add({ id: 'config.legacy_edge_to_edge', status: 'fail', severity: 'required', title: 'No removed android.adjustMarginsForEdgeToEdge', detail: 'Capacitor 8 removed android.adjustMarginsForEdgeToEdge; it is ignored and layouts that relied on it overlap the system bars.', fix: 'Delete it and pad with safe-area CSS (SystemBars handles insets).', checklist_id: 'design.android_edge_to_edge' })
  if (platforms.includes('ios') && config.ios?.contentInset === 'always' && input.project?.safeAreaCss)
    report.add({ id: 'config.double_inset', status: 'warn', severity: 'required', title: 'Safe area applied once', detail: 'ios.contentInset: \'always\' plus safe-area CSS pads the content twice.', fix: 'Remove ios.contentInset (default never) and keep the CSS padding.', checklist_id: 'design.safe_areas' })
}

function buildChecks(report: ReadinessReport, project: NonNullable<ReadinessInput['project']>, platforms: readonly Platform[]) {
  report.fact({ id: 'build.index_html', severity: 'blocker', title: 'Build output contains index.html', value: project.webDirHasIndexHtml, pass: true, ok: 'Capacitor needs index.html at the root of webDir.', bad: 'The web build folder has no index.html at its root.', fix: 'Switch the framework to static/SPA output and rebuild.', checklist_id: 'native.static_build' })
  report.fact({ id: 'build.no_localhost', severity: 'blocker', title: 'No localhost URLs in the build', value: project.localhostInBuild, pass: false, ok: 'API URLs point at reachable hosts.', bad: 'The built files call localhost or 127.0.0.1, which is the phone itself inside the app.', fix: 'Set the production API URL env variable and rebuild.', how_to_check: 'grep -rn "localhost:\\|127.0.0.1" <webDir>' })
  for (const platform of platforms) {
    report.fact({ id: `native.${platform}_project`, severity: 'blocker', title: `${platform}/ native project exists`, value: platform === 'ios' ? project.iosProject : project.androidProject, pass: true, ok: `npx cap add ${platform} creates the ${platform}/ project.`, bad: `There is no ${platform}/ folder.`, fix: `npx cap add ${platform}, then npx cap sync.`, how_to_check: `test -d ${platform}` })
  }
}

function designChecks(report: ReadinessReport, project: NonNullable<ReadinessInput['project']>, packages: Record<string, string> | undefined, platforms: readonly Platform[]) {
  const viewport = project.viewportMeta
  const shownViewport = `viewport is "${viewport?.slice(0, 200)}".`
  report.fact({ id: 'design.viewport_fit_cover', severity: 'blocker', title: 'Viewport uses viewport-fit=cover', value: viewport === undefined ? undefined : viewport.includes('viewport-fit=cover'), pass: true, ok: viewport === undefined ? 'Pass project.viewportMeta (the content of <meta name="viewport">).' : shownViewport, bad: shownViewport, fix: 'Use content="width=device-width, initial-scale=1, viewport-fit=cover".', checklist_id: 'design.viewport_fit_cover' })
  const uiKit = handlesSafeAreas(packages)
  if (uiKit)
    report.add({ id: 'design.safe_areas', status: 'pass', severity: 'required', title: 'Safe areas are padded', detail: `${uiKit} applies safe-area insets; do not add a second padding.`, fix: null, checklist_id: 'design.safe_areas' })
  else
    report.fact({ id: 'design.safe_areas', severity: 'required', title: 'Safe areas are padded', value: project.safeAreaCss, pass: true, ok: 'The app shell pads env(safe-area-inset-*) / --safe-area-inset-*.', bad: 'No safe-area-inset CSS found: headers and tab bars will sit under the notch and home indicator.', fix: 'Pad the app shell with var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) and the other sides.', checklist_id: 'design.safe_areas' })
  report.fact({ id: 'design.no_install_prompt', severity: 'required', title: 'No PWA install prompt in the app', value: project.installPrompt, pass: false, ok: 'No beforeinstallprompt UI inside the app.', bad: 'The app still shows a web install or download-the-app prompt.', fix: 'Hide install prompts and store banners when Capacitor.isNativePlatform().', checklist_id: 'design.no_web_chrome' })
  if (platforms.includes('android'))
    report.fact({ id: 'design.android_back_button', severity: 'required', title: 'Android back button handled', value: project.androidBackButton, pass: true, ok: 'App.addListener(\'backButton\') navigates back.', bad: 'No backButton listener: Android back exits the app from any screen.', fix: 'Add App.addListener(\'backButton\', ({ canGoBack }) => canGoBack ? history.back() : App.exitApp()).', checklist_id: 'design.app_navigation' })
  report.fact({ id: 'design.external_links', severity: 'required', title: 'External links open outside the WebView', value: project.externalLinksInBrowser, pass: true, miss: 'warn', ok: 'External links use the system browser or @capacitor/browser.', bad: 'External links open inside the app WebView and replace the app.', fix: 'Open them with Browser.open({ url }).', checklist_id: 'design.external_links' })
  report.fact({ id: 'design.offline_state', severity: 'required', title: 'Offline state', value: project.offlineState, pass: true, miss: 'warn', ok: 'The app renders an offline state.', bad: 'Without network the app shows a blank page or browser error.', fix: 'Detect @capacitor/network status and render an offline/retry screen.', checklist_id: 'design.offline_and_errors' })
  report.fact({ id: 'design.app_icon', severity: 'required', title: 'Custom app icon', value: project.customAppIcon, pass: true, ok: 'The app ships its own icon.', bad: 'The native projects still use the default Capacitor icon.', fix: 'Add assets/icon-only.png (1024x1024) and run npx @capacitor/assets generate.', checklist_id: 'design.icon_and_splash' })
  report.fact({ id: 'design.splash_screen', severity: 'recommended', title: 'Branded splash screen', value: project.splashScreen, pass: true, miss: 'warn', ok: 'The splash screen matches the first screen.', bad: 'The splash screen is the default one.', fix: 'Add assets/splash.png and splash-dark.png and run npx @capacitor/assets generate.', how_to_check: 'Compare ios/App/App/Assets.xcassets/Splash.imageset and android/app/src/main/res/drawable*/splash.png with the Capacitor template images.', checklist_id: 'design.icon_and_splash' })
  report.fact({ id: 'native.service_worker', severity: 'required', title: 'No service worker in the app build', value: project.serviceWorker, pass: false, miss: 'warn', ok: 'No service worker registration in the app build.', bad: 'A service worker registers inside the app and can serve stale bundles.', fix: 'Skip registration when Capacitor.isNativePlatform().', checklist_id: 'native.service_worker' })
}

function usageStringCheck(report: ReadinessReport, features: readonly MobileFeature[], iosUsageKeys: string[] | undefined) {
  const base = { id: 'ios.usage_strings', severity: 'blocker' as const, title: 'iOS purpose strings for every permission', checklist_id: 'native.permission_strings' }
  // "A or B" entries are satisfied by either key.
  const needed = [...new Set(features.flatMap(feature => PLUGINS[feature]?.flatMap(spec => spec.iosUsageKeys ?? []) ?? []))]
  if (!needed.length) {
    const detail = features.length ? 'The listed features need no iOS purpose string.' : 'No native features listed in app.features.'
    report.add({ ...base, status: features.length ? 'pass' : 'not_applicable', detail, fix: null })
    return
  }
  if (!iosUsageKeys) {
    report.add({ ...base, status: 'unknown', detail: `The listed features need ${needed.join(', ')}.`, fix: null, how_to_check: 'List the NS*UsageDescription keys in ios/App/App/Info.plist and pass them as project.iosUsageKeys.' })
    return
  }
  const present = new Set(iosUsageKeys)
  const missing = needed.filter(key => !key.split(' or ').some(option => present.has(option)))
  report.fact({ ...base, value: missing.length === 0, pass: true, ok: 'Every needed purpose string is in Info.plist.', bad: `Missing in Info.plist: ${missing.join(', ')}. The app crashes when it first requests that access.`, fix: 'Add each key with a specific sentence explaining why the app needs the access.' })
}

function platformChecks(report: ReadinessReport, project: NonNullable<ReadinessInput['project']>, features: readonly MobileFeature[], core: [number, number, number] | null, platforms: readonly Platform[]) {
  if (platforms.includes('ios')) {
    usageStringCheck(report, features, project.iosUsageKeys)
    report.fact({ id: 'ios.privacy_manifest', severity: 'required', title: 'PrivacyInfo.xcprivacy in the app target', value: project.iosPrivacyManifest, pass: true, ok: 'The app target has a privacy manifest.', bad: 'No privacy manifest: uploads get ITMS-91053 warnings and review can reject the app.', fix: 'Add PrivacyInfo.xcprivacy with the required-reason APIs the app and manifest-less plugins use.', checklist_id: 'apple.privacy' })
    if (core && (core[0] > 8 || (core[0] === 8 && core[1] >= 5)))
      report.fact({ id: 'ios.scene_lifecycle', severity: 'required', title: 'UIScene lifecycle adopted', value: project.iosSceneDelegate, pass: true, miss: 'warn', ok: 'The iOS project uses the scene lifecycle.', bad: 'No SceneDelegate.swift: Xcode 27 builds (required from April 2027) need the scene lifecycle.', fix: 'Apply the Capacitor 8.5 UIScene changes (SceneDelegate.swift, UIApplicationSceneManifest).', checklist_id: 'apple.sdk_requirement' })
  }
  if (platforms.includes('android')) {
    const target = project.androidTargetSdk
    report.fact({ id: 'android.target_sdk', severity: 'blocker', title: 'Android targetSdkVersion 36', value: target === undefined ? undefined : target >= 36, pass: true, ok: target === undefined ? 'Pass project.androidTargetSdk from android/variables.gradle.' : `targetSdkVersion is ${target}.`, bad: `targetSdkVersion is ${target}.`, fix: 'Set targetSdkVersion and compileSdkVersion to 36 (upgrade Capacitor if needed).', checklist_id: 'google.target_api' })
  }
}

function capgoChecks(report: ReadinessReport, packages: Record<string, string> | undefined, notifyAppReady: boolean | undefined) {
  const updater = packages?.['@capgo/capacitor-updater']
  report.fact({ id: 'capgo.live_updates', severity: 'recommended', title: 'Capgo live updates installed', value: packages ? Boolean(updater) : undefined, pass: true, miss: 'warn', ok: updater ? `@capgo/capacitor-updater ${updater}.` : 'Without the updater in the first store build, every web fix needs a store release.', bad: 'Without the updater in the first store build, every web fix needs a store release.', fix: 'The user runs npx @capgo/cli@latest init, or install @capgo/capacitor-updater and call notifyAppReady().', checklist_id: 'native.live_updates' })
  if (updater)
    report.fact({ id: 'capgo.notify_app_ready', severity: 'required', title: 'notifyAppReady() called at startup', value: notifyAppReady, pass: true, ok: 'CapacitorUpdater.notifyAppReady() runs on startup.', bad: 'Without notifyAppReady() every live update is rolled back after the timeout.', fix: 'Call CapacitorUpdater.notifyAppReady() at the top of the entry file.', how_to_check: 'grep -rn "notifyAppReady" src', checklist_id: 'native.live_updates' })
}

function storeChecks(report: ReadinessReport, app: NonNullable<ReadinessInput['app']>, platforms: readonly Platform[]) {
  const ios = platforms.includes('ios')
  const traits = new Set(app.traits ?? [])
  const nativeFeatureCount = (app.features ?? []).filter(feature => feature !== 'live_updates').length
  report.fact({ id: 'store.native_value', severity: 'required', title: 'Native value beyond the website', value: app.features === undefined ? undefined : nativeFeatureCount >= 2, pass: true, miss: 'warn', ok: app.features === undefined ? 'Pass app.features with the native features the app actually uses.' : `${nativeFeatureCount} native feature(s) listed.`, bad: `${nativeFeatureCount} native feature(s) listed.`, fix: 'Add native capabilities that serve the core use case (push, offline, camera, biometrics, share, native navigation) before submitting to Apple.', how_to_check: 'List the features that exist only in the app.', checklist_id: ios ? 'apple.minimum_functionality' : undefined })
  if (traits.has('accounts')) {
    report.fact({ id: 'store.account_deletion', severity: 'blocker', title: 'In-app account deletion', value: app.accountDeletion, pass: true, ok: 'Apple 5.1.1(v) and Google Play need in-app deletion when accounts exist.', bad: 'Users can create accounts but cannot delete them from the app.', fix: 'Add a Delete account action (and a web deletion link for Google Play).', checklist_id: ios ? 'apple.account_deletion' : 'google.account_deletion' })
    report.fact({ id: 'store.demo_account', severity: 'required', title: 'Demo account for reviewers', value: app.demoAccount, pass: true, ok: 'App Review and Play app access need working demo credentials.', bad: 'Reviewers cannot get past the login screen.', fix: 'Create a reviewer account and add it to App Store Connect and Play Console.', checklist_id: ios ? 'apple.demo_account' : 'google.data_safety' })
  }
  if (traits.has('third_party_login') && ios)
    report.fact({ id: 'store.sign_in_with_apple', severity: 'blocker', title: 'Sign in with Apple offered', value: app.signInWithApple, pass: true, ok: 'Apple 4.8 needs an equivalent privacy-preserving login.', bad: 'Third-party login on iOS without Sign in with Apple or an equivalent option is rejected under 4.8.', fix: 'Add Sign in with Apple with @capgo/capacitor-social-login.', checklist_id: 'apple.login_services' })
  if (traits.has('digital_goods'))
    report.fact({ id: 'store.store_billing', severity: 'blocker', title: 'Digital goods use store billing', value: app.nativeIap, pass: true, ok: 'Apple 3.1.1 and Google Play Billing apply to digital goods.', bad: 'Digital goods are sold through web checkout inside the app.', fix: 'Use @capgo/native-purchases or remove digital checkout from the store builds.', checklist_id: ios ? 'apple.in_app_purchase' : 'google.play_billing' })
}

function readinessVerdict(blocking: number, unknownBlockers: number): string {
  if (blocking)
    return `${blocking} blocking problem(s): fix them, then call this tool again with the updated facts.`
  if (unknownBlockers)
    return `${unknownBlockers} blocker check(s) need facts: inspect the project and call this tool again.`
  return 'No blocking problems found in the reported facts. Run the app on devices and go through capgo_get_mobile_checklist (apple_review, google_play) before submitting.'
}

export function checkReadiness(input: ReadinessInput, release: CapacitorRelease) {
  const platforms: readonly Platform[] = input.platforms?.length ? input.platforms : PLATFORMS
  const project = input.project ?? {}
  const app = input.app ?? {}
  const report = new ReadinessReport()
  const core = capacitorChecks(report, input.packages, platforms, release)
  nodeCheck(report, core, release, project.nodeVersion)
  configChecks(report, input, platforms)
  buildChecks(report, project, platforms)
  designChecks(report, project, input.packages, platforms)
  platformChecks(report, project, app.features ?? [], core, platforms)
  capgoChecks(report, input.packages, project.notifyAppReady)
  storeChecks(report, app, platforms)

  const checks = report.checks
  const blocking = checks.filter(check => check.status === 'fail' && check.severity !== 'recommended')
  const unknownBlockers = checks.filter(check => check.status === 'unknown' && check.severity === 'blocker')
  const summary = { pass: 0, fail: 0, warn: 0, unknown: 0, not_applicable: 0 }
  for (const check of checks)
    summary[check.status] += 1
  return {
    ready: blocking.length === 0 && unknownBlockers.length === 0,
    verdict: readinessVerdict(blocking.length, unknownBlockers.length),
    summary,
    blocking: blocking.map(check => check.id),
    to_inspect: unknownBlockers.map(check => ({ id: check.id, how_to_check: check.how_to_check })),
    checks,
    capacitor: { latest_version: release.latest, version_source: release.source },
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const PLAN_SOURCES = ['existing_web_app', 'website_only', 'new_app'] as const
export type PlanSource = typeof PLAN_SOURCES[number]
export const HOST_OS = ['macos', 'linux', 'windows', 'unknown'] as const
export type HostOs = typeof HOST_OS[number]

export interface PlanInput {
  source: PlanSource
  packages?: Record<string, string>
  framework?: FrameworkId
  template?: NewAppTemplate
  projectName?: string
  appName?: string
  appId?: string
  websiteUrl?: string
  platforms?: Platform[]
  features?: MobileFeature[]
  traits?: AppTrait[]
  packageManager?: PackageManager
  environment?: { shell?: boolean, os?: HostOs, xcode?: boolean, androidSdk?: boolean, nodeVersion?: string }
  existing?: { capacitorConfig?: boolean, ios?: boolean, android?: boolean, capgoApp?: boolean }
}

export interface PlanStep {
  id: string
  title: string
  detail: string
  commands: string[]
  files: { path: string, change: string }[]
  verify: string[]
  mcp_tools: string[]
  skill: string | null
  checklist_ids: string[]
  run_by: 'agent' | 'user'
}

export interface PlanPhase {
  id: string
  title: string
  goal: string
  steps: PlanStep[]
}

export interface RunOption {
  id: 'ios_simulator' | 'android_emulator' | 'physical_device' | 'capgo_preview_app' | 'capgo_cloud_simulator'
  title: string
  platforms: Platform[]
  available: 'yes' | 'no' | 'unknown'
  requirements: string[]
  steps: string[]
  mcp_tools: string[]
  cost: string
}

function step(value: Partial<PlanStep> & Pick<PlanStep, 'id' | 'title' | 'detail'>): PlanStep {
  return { commands: [], files: [], verify: [], mcp_tools: [], skill: null, checklist_ids: [], run_by: 'agent', ...value }
}

// Body padding works with any template; full-bleed designs move it to the fixed header and tab bar.
const SAFE_AREA_CSS = ':root {\n  --sat: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));\n  --sar: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));\n  --sab: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));\n  --sal: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));\n}\nhtml, body { overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }\nbody { box-sizing: border-box; min-height: 100dvh; padding: var(--sat) var(--sar) var(--sab) var(--sal); }\n/* Full-bleed layout instead: drop the body padding and pad the fixed bars. */\n/* .app-header { padding-top: var(--sat); } .app-tabbar { padding-bottom: var(--sab); } */'

const BACK_BUTTON_TS = 'import { App } from \'@capacitor/app\'\n\nApp.addListener(\'backButton\', ({ canGoBack }) => {\n  if (canGoBack)\n    window.history.back()\n  else\n    App.exitApp()\n})'

function runOptions(input: PlanInput, platforms: readonly Platform[], appId: string): RunOption[] {
  const env = input.environment ?? {}
  const os = env.os ?? 'unknown'
  const options: RunOption[] = []
  const known = (value: boolean | undefined, otherwise: 'no' | 'unknown' = 'unknown') => (value === true ? 'yes' as const : value === false ? 'no' as const : otherwise)
  if (platforms.includes('ios')) {
    options.push({
      id: 'ios_simulator',
      title: 'iOS Simulator on this Mac',
      platforms: ['ios'],
      available: os === 'macos' ? known(env.xcode) : os === 'unknown' ? 'unknown' : 'no',
      requirements: ['macOS with Xcode 26 or newer and an iOS simulator runtime (xcodebuild -version, xcrun simctl list devices available).'],
      steps: [
        'npx cap run ios --list to list simulators, then npx cap run ios --target <udid>.',
        'Or npx @capgo/cli@latest run device ios, which lists devices and resolves the command.',
        'Xcode 27 replaced Simulator.app with Device Hub and native-run may fail to launch: then run npx cap open ios, pick the simulator and choose Product > Run.',
        'Live reload: start the dev server on the LAN and run npx cap run ios -l --host <lan-ip> --port <port>. Never commit the resulting server.url.',
      ],
      mcp_tools: [],
      cost: 'Free.',
    })
  }
  if (platforms.includes('android')) {
    options.push({
      id: 'android_emulator',
      title: 'Android Emulator on this machine',
      platforms: ['android'],
      available: known(env.androidSdk),
      requirements: ['Android Studio (or the command-line SDK) with an emulator image and an AVD; JDK 21 for Capacitor 8 Gradle builds.'],
      steps: [
        'npx cap run android --list to list emulators, then npx cap run android --target <id>.',
        'Or npx cap open android and press Run in Android Studio.',
        'Live reload: npx cap run android -l --host <lan-ip> --port <port>.',
      ],
      mcp_tools: [],
      cost: 'Free.',
    })
  }
  options.push({
    id: 'physical_device',
    title: 'Physical iPhone or Android phone',
    platforms: [...platforms],
    available: 'unknown',
    requirements: ['iPhone: a Mac with Xcode, the device in Developer Mode and a signing team. Android: USB debugging enabled.', 'Or a Capgo Cloud Build delivered through TestFlight / Google Play internal testing (no Mac needed).'],
    steps: ['npx cap run ios --target <device-udid> / npx cap run android --target <device-id> with the phone connected and unlocked.', 'Without a Mac: request a Capgo Cloud Build and install it from TestFlight or the Play internal testing track.'],
    mcp_tools: ['capgo_request_build', 'capgo_start_build', 'capgo_get_build_status'],
    cost: 'Free locally; cloud builds use build minutes.',
  })
  options.push({
    id: 'capgo_preview_app',
    title: 'Capgo app preview (no native build)',
    platforms: [...platforms],
    available: input.environment?.shell === false ? 'unknown' : 'yes',
    requirements: ['The app exists in Capgo and a web bundle is uploaded.', 'Bundle preview enabled on the app (capgo_update_app with allow_preview: true).', 'The Capgo app on the phone: https://capgo.app/app_mobile/ (App Store and Google Play). Encrypted bundles cannot be previewed.'],
    steps: [
      'Upload the web build (capgo_get_upload_command, or bundle zip + capgo_prepare_bundle_upload + capgo_complete_bundle_upload).',
      'capgo_update_app with allow_preview: true.',
      `Open https://console.capgo.app/app/${appId}/bundles, pick the bundle, open Preview and scan the QR code with the Capgo app.`,
      'This previews web code only: plugins the Capgo app does not include will not work, so confirm native features in a real build.',
    ],
    mcp_tools: ['capgo_update_app', 'capgo_get_upload_command', 'capgo_list_bundles'],
    cost: 'Uses normal Capgo bundle storage.',
  })
  if (platforms.includes('ios')) {
    options.push({
      id: 'capgo_cloud_simulator',
      title: 'Capgo cloud iOS simulator',
      platforms: ['ios'],
      available: 'yes',
      requirements: ['A successful Capgo iOS build of this app (signing credentials saved with npx @capgo/cli@latest build init and stored on Capgo with build credentials push).'],
      steps: [
        'capgo_start_simulator with platform ios and build_job_id of the successful build; check install_error in the result.',
        `capgo_simulator_command open with bundle_id ${appId}, then screenshot after every tap to decide the next action.`,
        'capgo_stop_simulator when done: a running simulator holds a builder slot and uses build minutes.',
      ],
      mcp_tools: ['capgo_start_simulator', 'capgo_simulator_command', 'capgo_get_simulator', 'capgo_stop_simulator'],
      cost: 'One builder slot and build minutes while it runs.',
    })
  }
  return options
}

function nameFromWebsite(url: string | undefined): string | null {
  if (!url)
    return null
  try {
    const label = new URL(url).hostname.replace(/^www\./, '').split('.')[0]
    const words = label?.split(/[-_]+/).filter(Boolean) ?? []
    return words.length ? words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : null
  }
  catch {
    return null
  }
}

export function buildPlan(input: PlanInput, release: CapacitorRelease) {
  const pm = input.packageManager ?? 'npm'
  const platforms: readonly Platform[] = input.platforms?.length ? input.platforms : PLATFORMS
  const shell = input.environment?.shell !== false
  const features = [...new Set(input.features ?? [])]
  const traits = [...new Set(input.traits ?? [])]
  const warnings: string[] = []
  const latestMajor = parseVersion(release.latest)?.[0] ?? 8
  const detected = detectFramework(input.packages)
  const frameworkId: FrameworkId = input.source === 'new_app'
    ? 'vite'
    : input.framework ?? detected ?? 'unknown'
  const detectedFrom = input.source === 'new_app' ? 'template' as const : input.framework ? 'input' as const : detected ? 'packages' as const : 'none' as const
  const framework = frameworkInfo(frameworkId)
  if (input.framework && detected && input.framework !== detected)
    warnings.push(`framework ${input.framework} was given but the packages look like ${frameworkInfo(detected).name}. Using ${framework.name}.`)

  const identity = suggestAppId({ appId: input.appId, websiteUrl: input.websiteUrl, appName: input.appName, platforms })
  const appName = input.appName ?? nameFromWebsite(input.websiteUrl) ?? 'My App'
  if (!input.appName)
    warnings.push(`appName defaulted to "${appName}". Confirm the name shown under the icon with the user.`)
  warnings.push(...identity.warnings)

  const installed = parseVersion(input.packages?.['@capacitor/core'])
  const capacitorAction = !installed ? 'install' as const : installed[0] < latestMajor ? 'upgrade' as const : 'keep' as const
  const nodeNeeded = nodeRequirement(latestMajor)
  const nodeVersion = parseVersion(input.environment?.nodeVersion)
  if (nodeVersion && nodeVersion[0] < Number(nodeNeeded.replace('>=', '')))
    warnings.push(`Node ${input.environment!.nodeVersion} is too old: Capacitor ${latestMajor} needs Node ${nodeNeeded}.`)
  if (input.source === 'website_only')
    warnings.push('Only a website URL was provided. Capacitor packages your web build into the app, so you need the source code (or a static export) of the site. Wrapping the live URL with server.url is a thin web wrapper that Apple usually rejects under 4.2, cannot work offline and cannot receive Capgo live updates.')
  if (!shell)
    warnings.push('The agent cannot run commands here. Prepare the code changes and a docs/mobile-release-handoff.md with the commands below; the user or CI runs them. Native builds can run in Capgo Cloud without a Mac.')
  if (platforms.includes('ios') && input.environment?.os && input.environment.os !== 'macos')
    warnings.push('iOS builds need Xcode, which only runs on macOS. Use Capgo Cloud Build for iOS builds and TestFlight or the Capgo cloud simulator to run them.')
  if (release.source === 'fallback')
    warnings.push(`npm did not answer, so the latest Capacitor version is the last known one (${release.latest}). Commands use @latest and stay correct.`)

  const projectDir = input.projectName ? slug(input.projectName) : slug(appName)
  const webDir = framework.webDir
  // Existing apps get a build:mobile script running the framework's static build (e.g. nuxt generate),
  // because their build script may do a server build. New Vite apps and unknown stacks keep build.
  const mobileScript = input.source !== 'new_app' && framework.id !== 'unknown' && framework.buildCommand ? 'build:mobile' : null
  const buildRun = mobileScript ? runScript(pm, mobileScript) : framework.buildCommand ? runScript(pm, 'build') : null
  const syncCommand = buildRun ? `${buildRun} && npx cap sync` : 'npx cap sync'
  const webDirArg = shellQuote(webDir)
  const capacitorPackages = ['@capacitor/core@latest', ...platforms.map(platform => `@capacitor/${platform}@latest`)]
  // The Capgo phase installs the updater (ideally through npx @capgo/cli@latest init), so the plugin step leaves it out.
  const plugins = recommendPlugins({ features: [...features, 'live_updates'], platforms, packageManager: pm, installed: input.packages })
  const featurePlugins = recommendPlugins({ features: features.filter(feature => feature !== 'live_updates'), platforms, packageManager: pm, installed: input.packages })
  // Projects that already depend on Capacitor normally have their config and native folders.
  const existing = {
    capacitorConfig: input.existing?.capacitorConfig ?? Boolean(installed),
    ios: input.existing?.ios ?? Boolean(installed && input.packages?.['@capacitor/ios']),
    android: input.existing?.android ?? Boolean(installed && input.packages?.['@capacitor/android']),
    capgoApp: input.existing?.capgoApp ?? false,
  }

  const phases: PlanPhase[] = []

  // 1. Prepare.
  const prepareSteps: PlanStep[] = [
    step({
      id: 'confirm_scope',
      title: 'Confirm name, app ID, platforms and native features with the user',
      detail: `Proposed: "${appName}" with app ID ${identity.app_id} for ${platforms.join(' and ')}. The app ID becomes the iOS bundle identifier and Android applicationId and cannot change after the first store release.`,
      run_by: 'user',
      verify: ['The user approved the app name, app ID and platform list.'],
    }),
    step({
      id: 'check_tooling',
      title: 'Check local tooling',
      detail: `Capacitor ${latestMajor} needs Node ${nodeNeeded}. iOS builds need macOS with Xcode 26+; Android builds need Android Studio with JDK 21. Without them, use Capgo Cloud Build.`,
      commands: shell
        ? [
            'node --version',
            ...(platforms.includes('ios') && (input.environment?.os ?? 'unknown') !== 'linux' && input.environment?.os !== 'windows' ? ['xcodebuild -version'] : []),
            ...(platforms.includes('android') ? ['java -version'] : []),
          ]
        : [],
      verify: [`node --version prints ${nodeNeeded.replace('>=', 'v')} or newer.`],
    }),
  ]
  if (input.source === 'existing_web_app' || input.source === 'website_only') {
    prepareSteps.push(step({
      id: 'audit',
      title: 'Audit the web app before changing it',
      detail: 'Report to the user: framework and build output, server-only features to move, auth (cookie vs token, OAuth redirects), what is sold (digital goods need store billing), native capabilities wanted, offline expectations, deep links, and PWA pieces (service worker, manifest, install prompts). If the app offers nothing beyond the website, say so and propose native value before investing in store submission.',
      commands: shell ? ['grep -rn "serviceWorker.register\\|beforeinstallprompt" src', 'grep -rln "use server\\|getServerSideProps\\|+page.server\\|server/api" . --include=*.ts --include=*.tsx --include=*.js --exclude-dir=node_modules'] : [],
      skill: 'webapp-to-capacitor',
      checklist_ids: ['apple.minimum_functionality'],
    }))
  }
  phases.push({ id: 'prepare', title: 'Prepare', goal: 'Agree on the app identity and know what the web app needs before touching it.', steps: prepareSteps })

  // 2. Web build.
  if (input.source === 'new_app') {
    const template = `${input.template ?? 'react'}-ts`
    phases.push({
      id: 'scaffold',
      title: 'Create the web app',
      goal: 'A Vite app that builds to a static dist/ folder.',
      steps: [
        step({
          id: 'create_vite_app',
          title: `Scaffold a Vite ${input.template ?? 'react'} app`,
          detail: 'Vite produces a static single-page app that Capacitor can package as is. Pick a mobile UI kit if the user wants native-looking components (Ionic or Konsta UI) and design for phone width first.',
          commands: [createViteCommand(pm, projectDir, template), `cd ${projectDir}`, installCommand(pm)],
          verify: [`${runScript(pm, 'build')} writes dist/index.html.`],
          skill: 'framework-to-capacitor',
        }),
        step({
          id: 'mobile_first_shell',
          title: 'Build a mobile app shell',
          detail: 'Start with an app layout: a header and a bottom tab bar padded for safe areas, screens that fit 100dvh, touch targets of at least 44pt/48dp, and no website header or footer.',
          files: [{ path: 'src/index.css (or the global stylesheet)', change: SAFE_AREA_CSS }],
          checklist_ids: ['design.safe_areas', 'design.app_navigation', 'design.touch_targets'],
          skill: 'safe-area-handling',
        }),
      ],
    })
  }
  else {
    const staticSteps: PlanStep[] = []
    if (mobileScript) {
      staticSteps.push(step({
        id: 'mobile_build_script',
        title: 'Add a build:mobile script',
        detail: `Every later step runs this script, so it must write ${webDir}/index.html. Start from the framework's static build command and keep any steps the existing build script needs (code generation, env files); do not reuse a build script that produces a server build.`,
        files: [{ path: 'package.json', change: `"scripts": { "build:mobile": "${framework.buildCommand}" }` }],
        verify: [`${buildRun} writes ${webDir}/index.html.`],
      }))
    }
    staticSteps.push(
      step({
        id: 'static_output',
        title: framework.staticByDefault ? `Confirm the ${framework.name} static output` : `Switch ${framework.name} to a static build`,
        detail: framework.steps.join(' '),
        commands: shell && buildRun ? [buildRun, `test -f ${webDirArg}/index.html && echo "index.html OK"`] : [],
        verify: [`${webDir}/index.html exists after the build.`, 'No page depends on SSR, API routes or server actions at runtime.'],
        skill: 'framework-to-capacitor',
        checklist_ids: ['native.static_build'],
      }),
    )
    if (framework.serverFeatures.length) {
      staticSteps.push(step({
        id: 'move_server_code',
        title: 'Move server-only code to a hosted API',
        detail: `Look for: ${framework.serverFeatures.join(', ')}. List them for the user and agree where each moves (existing backend, serverless function or native plugin) before deleting anything. The app calls the API over HTTPS from capacitor://localhost (iOS) and https://localhost (Android).`,
        checklist_ids: ['native.api_origins', 'native.auth_redirects'],
        skill: 'framework-to-capacitor',
      }))
    }
    phases.push({ id: 'static_build', title: 'Static web build', goal: `The web app builds to ${webDir}/index.html with no server at runtime.`, steps: staticSteps })
  }

  // 3. Capacitor.
  const capacitorSteps: PlanStep[] = []
  if (capacitorAction === 'upgrade') {
    capacitorSteps.push(step({
      id: 'upgrade_capacitor',
      title: `Upgrade Capacitor ${installed![0]} to ${latestMajor}`,
      detail: 'Commit first. Upgrade the CLI, then npx cap migrate updates the @capacitor packages, official plugins and the native projects. Upgrade third-party plugins to their matching major and review the migration guide for manual steps.',
      commands: [addCommand(pm, ['@capacitor/cli@latest'], true), 'npx cap migrate'],
      verify: ['All @capacitor/* packages share the same major.', 'npx cap sync finishes without errors.'],
      skill: 'capacitor-app-upgrades',
    }))
  }
  else if (capacitorAction === 'install') {
    capacitorSteps.push(step({
      id: 'install_capacitor',
      title: `Install Capacitor ${release.latest}`,
      detail: `Installs the latest Capacitor (${release.latest}${release.next ? `; ${release.next} is a pre-release on next, do not use it for production` : ''}).`,
      commands: [addCommand(pm, capacitorPackages), addCommand(pm, ['@capacitor/cli@latest'], true)],
      verify: ['package.json lists @capacitor/core, @capacitor/cli and one package per platform on the same major.'],
    }))
  }
  if (capacitorAction !== 'install') {
    // Upgrades and current installs can still lack a platform package (an iOS-only app adding Android).
    const missingPackages = platforms.filter(platform => !input.packages?.[`@capacitor/${platform}`]).map(platform => `@capacitor/${platform}@latest`)
    const missingCli = capacitorAction === 'keep' && !input.packages?.['@capacitor/cli']
    if (missingPackages.length || missingCli) {
      capacitorSteps.push(step({
        id: 'install_platform_packages',
        title: 'Install the missing Capacitor packages',
        detail: 'npx cap add needs the platform package installed first, on the same major as @capacitor/core.',
        commands: [
          ...(missingPackages.length ? [addCommand(pm, missingPackages)] : []),
          ...(missingCli ? [addCommand(pm, ['@capacitor/cli@latest'], true)] : []),
        ],
        verify: ['All @capacitor/* packages share the same major.'],
      }))
    }
  }
  if (existing.capacitorConfig) {
    capacitorSteps.push(step({
      id: 'align_config',
      title: 'Point the existing capacitor.config at the mobile build',
      detail: `Edit only these keys and keep every other setting: webDir must be the folder the mobile build writes (${webDir}), otherwise npx cap sync copies a missing or stale folder. Remove server.url and server.cleartext from the release config. Keep the appId the app already ships with; changing it creates a different app in the stores.`,
      files: [{ path: 'capacitor.config.ts (or .json)', change: `webDir: '${webDir}'` }],
      verify: [`webDir in capacitor.config is ${webDir} and ${webDir}/index.html exists after the build.`, 'No server.url in the release config.'],
      checklist_ids: ['native.static_build', 'native.bundled_assets'],
    }))
  }
  else {
    capacitorSteps.push(step({
      id: 'cap_init',
      title: 'Create capacitor.config.ts',
      detail: `Sets the app name, app ID and webDir. Run it only after the user confirmed the app ID. ${framework.id === 'angular' ? 'Replace <project> with the angular.json project name.' : ''}`.trim(),
      commands: [`npx cap init ${shellQuote(appName)} ${identity.app_id} --web-dir ${webDirArg}`],
      files: [{ path: 'capacitor.config.ts', change: `import type { CapacitorConfig } from '@capacitor/cli'\n\nconst config: CapacitorConfig = {\n  appId: '${identity.app_id}',\n  appName: ${JSON.stringify(appName)},\n  webDir: '${webDir}',\n}\n\nexport default config` }],
      verify: ['capacitor.config.ts has the confirmed appId and the webDir of the build output, and no server.url.'],
      checklist_ids: ['native.bundled_assets'],
    }))
  }
  const missingPlatforms = platforms.filter(platform => !(platform === 'ios' ? existing.ios : existing.android))
  if (missingPlatforms.length && buildRun) {
    capacitorSteps.push(step({
      id: 'build_web',
      title: 'Build the web assets',
      detail: `npx cap add copies ${webDir} into the native project, so it must exist first.`,
      commands: [buildRun],
      verify: [`${webDir}/index.html exists.`],
    }))
  }
  for (const platform of missingPlatforms) {
    capacitorSteps.push(step({
      id: `add_${platform}`,
      title: `Add the ${platform === 'ios' ? 'iOS' : 'Android'} project`,
      detail: platform === 'ios'
        ? 'Creates ios/ using Swift Package Manager (the Capacitor 8 default; keep it: CocoaPods trunk becomes read-only in December 2026).'
        : 'Creates android/ targeting API 36.',
      commands: [`npx cap add ${platform}`],
      verify: [`${platform}/ exists and npx cap sync ${platform} succeeds.`],
    }))
  }
  capacitorSteps.push(step({
    id: 'sync',
    title: 'Build and sync',
    detail: 'Run after every web change before opening a native project, and after every plugin install.',
    commands: [syncCommand],
    verify: ['npx cap sync prints no [error] lines.', 'npx cap ls lists the installed plugins for each platform.'],
  }))
  phases.push({ id: 'capacitor', title: 'Capacitor shell', goal: `Native ${platforms.join(' and ')} projects on Capacitor ${latestMajor}.`, steps: capacitorSteps })

  // 4. Native UX.
  phases.push({
    id: 'native_ux',
    title: 'Mobile design and UX',
    goal: 'The app looks and behaves like an app: safe areas, keyboard, navigation, icons and offline states. This is also the defence against Apple 4.2.',
    steps: [
      step({
        id: 'viewport_and_safe_areas',
        title: 'Viewport and safe areas',
        detail: 'Add viewport-fit=cover and pad the app shell once with the safe-area variables (Capacitor 8 SystemBars injects --safe-area-inset-* on older Android WebViews). Skip the CSS if Ionic or Konsta UI already pads.',
        files: [
          { path: 'index.html', change: '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />' },
          { path: 'global stylesheet', change: SAFE_AREA_CSS },
        ],
        verify: ['Header and tab bar clear the notch, Dynamic Island and home indicator in portrait and landscape.'],
        skill: 'safe-area-handling',
        checklist_ids: ['design.viewport_fit_cover', 'design.safe_areas', 'design.android_edge_to_edge'],
      }),
      step({
        id: 'navigation_and_back',
        title: 'App navigation and the Android back button',
        detail: 'Replace website header/footer navigation with an app shell (tabs or stack). Handle Android back. Remove PWA install prompts, "download our app" banners and the service worker in the native build. Open external links with @capacitor/browser.',
        files: [{ path: 'src/native.ts (imported once at startup)', change: BACK_BUTTON_TS }],
        verify: ['Android back navigates back and exits from the root screen.', 'No install prompt or store banner shows inside the app.'],
        checklist_ids: ['design.app_navigation', 'design.no_web_chrome', 'design.external_links', 'native.service_worker'],
        skill: 'webapp-to-capacitor',
      }),
      step({
        id: 'keyboard_and_forms',
        title: 'Keyboard and forms',
        detail: 'Install @capacitor/keyboard, pick a resize mode and make sure every focused input stays visible.',
        verify: ['The last field of every form stays visible with the keyboard open on a small phone.'],
        skill: 'capacitor-keyboard',
        checklist_ids: ['design.keyboard', 'design.touch_targets'],
      }),
      step({
        id: 'icon_and_splash',
        title: 'App icon and splash screen',
        detail: 'Ask the user for a 1024x1024 icon and a splash image (2732x2732, artwork centered) if they are missing; never ship the default Capacitor icon.',
        commands: [addCommand(pm, ['@capacitor/assets@latest'], true), 'npx @capacitor/assets generate', 'npx cap sync'],
        files: [{ path: 'assets/', change: 'icon-only.png, icon-foreground.png, icon-background.png, splash.png, splash-dark.png' }],
        verify: ['The home screen shows the app icon on both platforms; no white flash at launch.'],
        skill: 'capacitor-splash-screen',
        checklist_ids: ['design.icon_and_splash'],
      }),
      step({
        id: 'offline_and_polish',
        title: 'Offline states and native polish',
        detail: 'Render an offline/retry screen, disable page bounce and tap highlight, support dark mode or force one theme, and label icon buttons for screen readers.',
        verify: ['Airplane mode cold start shows an app-styled offline screen.'],
        skill: 'capacitor-offline-first',
        checklist_ids: ['design.offline_and_errors', 'design.native_feel', 'design.dark_mode', 'design.accessibility'],
      }),
    ],
  })

  // 5. Native features.
  phases.push({
    id: 'native_features',
    title: 'Native features and plugins',
    goal: 'Add the native capabilities the product needs, with permissions declared and requested in context.',
    steps: [
      step({
        id: 'install_plugins',
        title: 'Install the recommended plugins',
        detail: `Official @capacitor plugins first, Capgo @capgo plugins where they cover more. See plugins in this result (${featurePlugins.plugins.length} packages here; the updater is set up in the Capgo phase). Call capgo_recommend_plugins again when a new feature comes up.`,
        // Rebuild so the design and feature edits made since the Capacitor phase reach the native projects.
        commands: [...(featurePlugins.install_command ? [featurePlugins.install_command] : []), syncCommand, 'npx cap ls'],
        files: featurePlugins.ios_usage_keys.length && platforms.includes('ios') ? [{ path: 'ios/App/App/Info.plist', change: `Add ${featurePlugins.ios_usage_keys.join(', ')} with specific purpose strings.` }] : [],
        verify: ['npx cap ls lists every plugin for each platform.', 'Each permission prompt appears only when the user starts the matching feature, and denial is handled.'],
        mcp_tools: ['capgo_recommend_plugins'],
        skill: 'capacitor-plugins',
        checklist_ids: ['native.permission_strings', 'native.real_devices'],
      }),
    ],
  })

  // 6. Run.
  phases.push({
    id: 'run',
    title: 'Run the app',
    goal: 'See the app on a simulator, emulator or device and fix what breaks there.',
    steps: [
      step({
        id: 'run_locally',
        title: 'Start a simulator or emulator',
        detail: 'Rebuild and sync first: npx cap run only syncs the last web build, so skipping the build shows stale code. Then pick the first available run option from run_options. Inspect the WebView with Safari Web Inspector (iOS) or chrome://inspect (Android) for console errors, CORS failures and 404s.',
        commands: [syncCommand, ...platforms.map(platform => `npx cap run ${platform} --list`)],
        verify: ['The app opens on the first screen without a white screen.', 'Navigate to a nested route, background and resume, then kill and relaunch.'],
        skill: 'debugging-capacitor',
      }),
      step({
        id: 'check_readiness',
        title: 'Check readiness',
        detail: 'Gather the facts listed in capgo_check_mobile_readiness (config, viewport meta, Info.plist keys, targetSdk, safe-area CSS, ...) and call it. Fix every failing blocker and call it again.',
        mcp_tools: ['capgo_check_mobile_readiness'],
      }),
    ],
  })

  // 7. Capgo.
  phases.push({
    id: 'capgo',
    title: 'Capgo: app, live updates and cloud builds',
    goal: 'Register the app, ship web fixes with live updates and build native binaries without a local Mac.',
    steps: [
      step({
        id: 'register_app',
        title: 'Register the app in Capgo',
        detail: 'Find the organization, then create the app with the confirmed app ID. If the ID is taken, the result explains the options.',
        mcp_tools: existing.capgoApp ? ['capgo_get_app'] : ['capgo_whoami', 'capgo_list_organizations', 'capgo_add_app'],
        verify: ['capgo_get_app returns the app.'],
      }),
      step({
        id: 'live_updates',
        title: 'Add Capgo live updates before the first store build',
        detail: 'Recommended: the user runs npx @capgo/cli@latest init in the app folder (interactive: installs the updater, adds notifyAppReady, creates the channel and uploads the first bundle). Manual alternative: install the plugin, make the file changes below, then build and sync so the native projects carry the updater wiring. Live updates change web assets only.',
        commands: [addCommand(pm, ['@capgo/capacitor-updater@latest']), syncCommand],
        files: [
          { path: 'entry file (main.ts / main.tsx / app root)', change: 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\'\n\nCapacitorUpdater.notifyAppReady()' },
          { path: 'capacitor.config.ts', change: 'plugins: { CapacitorUpdater: { autoUpdate: \'atBackground\' } }' },
        ],
        verify: ['npx @capgo/cli@latest doctor reports no problem.'],
        skill: 'capgo-live-updates',
        checklist_ids: ['native.live_updates', 'release.live_update_policy'],
      }),
      step({
        id: 'device_channel',
        title: 'Create the channel devices read updates from',
        detail: 'Skip this when npx @capgo/cli@latest init already set up the channel. A new app uploads to a dev channel that devices do not read, so updates would answer no_channel. After the user confirms, create a production channel with public: true (the default channel for devices without an override) and make it the upload target with capgo_update_app default_upload_channel, or pass that channel when uploading. To test on simulators or debug builds, use a separate channel with allow_emulator and allow_dev enabled.',
        verify: ['capgo_list_channels shows a public channel for the platforms you ship, and it is the default upload channel.'],
        mcp_tools: ['capgo_list_channels', 'capgo_add_channel', 'capgo_update_app'],
        skill: 'capgo-live-updates',
        checklist_ids: ['release.channels'],
      }),
      step({
        id: 'upload_bundle',
        title: 'Upload the first web bundle',
        detail: 'Build, then upload to the device channel with the command from capgo_get_upload_command, or package with npx @capgo/cli@latest bundle zip <appId> --for-upload --json and use capgo_prepare_bundle_upload, a PUT to the signed URL and capgo_complete_bundle_upload. Enable allow_preview to open it in the Capgo app.',
        commands: buildRun ? [buildRun] : [],
        mcp_tools: ['capgo_get_upload_command', 'capgo_prepare_bundle_upload', 'capgo_complete_bundle_upload', 'capgo_update_app'],
        checklist_ids: ['release.channels'],
      }),
      step({
        id: 'signing_credentials',
        title: 'Save signing credentials and store them on Capgo',
        detail: 'Interactive and secret: the user runs build init once per platform (it saves the credentials on their machine), then stores them on Capgo, which builds requested through the hosted MCP use. An agent with file access may instead upload the saved credentials file to the single-use URL from capgo_prepare_build_credentials_upload after the user confirms the app, platform and mode. Never paste credential contents into the chat or tool arguments.',
        commands: platforms.flatMap(platform => [
          `npx @capgo/cli@latest build init --platform ${platform}`,
          `npx @capgo/cli@latest build credentials push ${identity.app_id} --platform ${platform}`,
        ]),
        verify: ['capgo_get_build_credentials lists stored credentials for each platform.'],
        mcp_tools: ['capgo_get_build_credentials', 'capgo_prepare_build_credentials_upload'],
        skill: 'capgo-native-builds',
        checklist_ids: ['release.cloud_build'],
        run_by: 'user',
      }),
      step({
        id: 'cloud_build',
        title: 'Native builds with Capgo Cloud Build',
        detail: 'build zip archives the native folders as they are, so build and sync first: the store binary must carry the current web bundle, including notifyAppReady. Then capgo_request_build returns a job and a signed URL: PUT the archive there and call capgo_start_build. Ask the user before starting: builds use build minutes and can upload to the stores. iOS builds run on the current Xcode.',
        commands: [syncCommand, ...platforms.map(platform => `npx @capgo/cli@latest build zip ${identity.app_id} --platform ${platform} --json`)],
        verify: ['capgo_get_build_status reports succeeded for each platform; read capgo_get_build_logs on failure.'],
        mcp_tools: ['capgo_request_build', 'capgo_start_build', 'capgo_get_build_status', 'capgo_get_build_logs'],
        skill: 'capgo-native-builds',
        checklist_ids: ['release.cloud_build', 'apple.sdk_requirement', 'google.app_bundle'],
      }),
    ],
  })

  // 8. Store.
  phases.push({
    id: 'store',
    title: 'Store submission',
    goal: 'Pass App Review and Google Play review on the first try.',
    steps: [
      step({
        id: 'store_checklist',
        title: 'Go through the store checklist',
        detail: 'Call capgo_get_mobile_checklist with topics apple_review, google_play and release and the app traits (accounts, digital goods, third-party login, ...). Accounts: Apple Developer Program (99 USD/year), Google Play Console (25 USD once). Personal Play accounts need a 12-tester, 14-day closed test before production.',
        mcp_tools: ['capgo_get_mobile_checklist'],
        skill: 'capacitor-app-store',
        checklist_ids: ['apple.developer_program', 'google.developer_account', 'google.closed_testing'],
        run_by: 'user',
      }),
      step({
        id: 'apple_preflight',
        title: 'Apple review preflight',
        detail: 'Before the first iOS submission, audit the app against the App Review Guidelines (4.2 minimum functionality, 5.1.1(v) account deletion, 4.8 login, 3.1.1 purchases, privacy) and prepare a demo account and review notes that list the native features.',
        skill: 'capacitor-apple-review-preflight',
        checklist_ids: ['apple.minimum_functionality', 'apple.privacy', 'apple.demo_account'],
      }),
    ],
  })

  const nextTool = existing.capgoApp
    ? { name: 'capgo_check_mobile_readiness', reason: 'Verify the project against the checklist with the facts you inspected.' }
    : { name: 'capgo_whoami', reason: 'Confirm the Capgo account, then capgo_list_organizations and capgo_add_app once the user confirmed the app ID.' }

  return {
    summary: `${input.source === 'new_app' ? 'New Vite' : framework.name} app to ${platforms.join(' and ')} with Capacitor ${release.latest}: ${phases.length} phases. ${shell ? 'Run the agent steps in order, ask the user for the user steps.' : 'Prepare a handoff: this environment cannot run commands.'}`,
    mode: shell ? 'run_commands' as const : 'handoff' as const,
    source: input.source,
    framework: {
      id: framework.id,
      name: framework.name,
      detected_from: detectedFrom,
      web_dir: webDir,
      build_command: buildRun,
      static_export_required: !framework.staticByDefault,
      server_features_to_check: framework.serverFeatures,
    },
    capacitor: {
      latest_version: release.latest,
      next_version: release.next,
      version_source: release.source,
      installed_version: input.packages?.['@capacitor/core'] ?? null,
      action: capacitorAction,
      node_requirement: nodeNeeded,
    },
    app: { name: appName, app_id: identity.app_id, app_id_source: identity.source },
    platforms: [...platforms],
    warnings,
    phases,
    plugins: plugins.plugins,
    run_options: runOptions(input, platforms, identity.app_id),
    checklist: buildChecklist({ topics: ['design', 'native'], platforms, traits }).items.map(item => ({ id: item.id, severity: item.severity, title: item.title })),
    skills: {
      install_command: SKILLS_INSTALL_COMMAND,
      items: (['webapp-to-capacitor', 'framework-to-capacitor', 'safe-area-handling', 'capacitor-plugins', 'capacitor-app-store', 'capacitor-apple-review-preflight', 'capgo-live-updates', 'capgo-native-builds'] as SkillName[]).map(skillRef),
    },
    next_tool: nextTool,
  }
}
