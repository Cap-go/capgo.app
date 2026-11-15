import { z } from 'zod'

/**
 * Web app to mobile app guidance for the hosted MCP.
 *
 * The hosted server cannot read the user's files. The agent reports what it found in the project and
 * these pure functions return a typed plan, plugin picks, checklists and a readiness verdict. The rules
 * come from Capgo's public Capacitor skills (https://github.com/Cap-go/capgo-skills); every item names
 * the skill an agent can load for the full procedure.
 */

export const PLATFORMS = ['ios', 'android'] as const
export type Platform = typeof PLATFORMS[number]
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

let releaseCache: { at: number, value: CapacitorRelease } | undefined

/** Latest @capacitor/core from npm, cached per isolate. Never throws: falls back to the pinned release. */
export async function latestCapacitorRelease(fetcher: typeof fetch = fetch, now = Date.now()): Promise<CapacitorRelease> {
  if (releaseCache && now - releaseCache.at < RELEASE_CACHE_MS)
    return releaseCache.value
  try {
    const response = await fetcher(CAPACITOR_DIST_TAGS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) })
    if (!response.ok)
      throw new Error(`npm registry returned ${response.status}`)
    const tags = z.object({ latest: z.string(), next: z.string().optional() }).parse(await response.json())
    if (parseVersion(tags.latest) === null)
      throw new Error('npm registry returned an invalid version')
    const value: CapacitorRelease = { latest: tags.latest, next: tags.next ?? null, source: 'npm' }
    releaseCache = { at: now, value }
    return value
  }
  catch {
    return { latest: CAPACITOR_FALLBACK_RELEASE.latest, next: CAPACITOR_FALLBACK_RELEASE.next, source: 'fallback' }
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
  const match = /^\s*(?:[\^~>=v]|>=)*\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(range)
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
// Skills (Cap-go/capgo-skills)
// ---------------------------------------------------------------------------

const SKILLS_REPOSITORY = 'https://github.com/Cap-go/capgo-skills'
export const SKILLS_INSTALL_COMMAND = 'npx skills add Cap-go/capgo-skills'

export const SKILL_PURPOSES = {
  'webapp-to-capacitor': 'Whole migration of an existing web app, PWA or SPA into a store-ready app.',
  'framework-to-capacitor': 'Framework static build settings, webDir, routing and env variable traps.',
  'capacitor-app-upgrades': 'Upgrading an existing Capacitor app to the latest major.',
  'safe-area-handling': 'Notch, Dynamic Island, home indicator and Android edge-to-edge insets.',
  'capacitor-keyboard': 'Keyboard covering inputs, resize modes and accessory bar.',
  'capacitor-splash-screen': 'App icon, splash screen and launch states.',
  'capacitor-offline-first': 'Offline data and error states instead of browser error pages.',
  'capacitor-accessibility': 'VoiceOver, TalkBack, text scaling and contrast.',
  'capacitor-performance': 'Startup time, bundle size and smooth scrolling.',
  'capacitor-ios-resizability': 'iPad windowing, rotation and resizable scenes.',
  'capacitor-plugins': 'Choosing and wiring official @capacitor and Capgo @capgo plugins.',
  'capacitor-deep-linking': 'Universal links and Android App Links.',
  'capacitor-push-notifications': 'APNs and FCM push notification setup.',
  'subscription-app-revenue': 'In-app purchases, subscriptions and paywalls.',
  'ionic-design': 'Ionic components that follow iOS and Android design.',
  'konsta-ui': 'Konsta UI components with Tailwind.',
  'capacitor-testing': 'Unit, end-to-end and device testing.',
  'debugging-capacitor': 'Inspecting the WebView and native logs.',
  'capacitor-app-store': 'Store submission: signing, versions, listings, privacy forms and rollout.',
  'capacitor-apple-review-preflight': 'Audit against the App Review Guidelines before submitting.',
  'capgo-native-builds': 'Capgo Cloud iOS and Android builds, signing and store upload.',
  'capgo-live-updates': 'Capgo live updates: updater plugin, notifyAppReady, channels and limits.',
} as const
export type SkillName = keyof typeof SKILL_PURPOSES

export function skillRef(name: SkillName) {
  return { name, url: `${SKILLS_REPOSITORY}/tree/main/skills/${name}`, use_for: SKILL_PURPOSES[name] }
}

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

export const FRAMEWORK_IDS = [
  'nextjs',
  'nuxt',
  'sveltekit',
  'angular',
  'react_router',
  'remix',
  'astro',
  'solidstart',
  'qwik',
  'gatsby',
  'create_react_app',
  'vue_cli',
  'vite',
  'static_html',
  'unknown',
] as const
export type FrameworkId = typeof FRAMEWORK_IDS[number]

export const NEW_APP_TEMPLATES = ['react', 'vue', 'svelte', 'solid', 'preact', 'vanilla'] as const
export type NewAppTemplate = typeof NEW_APP_TEMPLATES[number]

interface FrameworkInfo {
  id: FrameworkId
  name: string
  /** Any of these packages identifies the framework. Checked in FRAMEWORKS order. */
  packages: string[]
  webDir: string
  buildCommand: string
  /** The default build already emits a static index.html. */
  staticByDefault: boolean
  steps: string[]
  /** Server-only features to find and move before the static build works. */
  serverFeatures: string[]
}

const ROUTING_NOTE = 'Capacitor serves the root index.html for any URL without a file extension, so keep navigation client-side and route deep links through App.addListener(\'appUrlOpen\', ...).'
const BASE_PATH_NOTE = 'Keep the asset base at / (no CDN assetPrefix or sub-path base) in the mobile build.'
const ENV_NOTE = 'Public env variables are inlined at build time: rebuild before every npx cap sync and never point a release build at localhost.'

const FRAMEWORKS: FrameworkInfo[] = [
  {
    id: 'nextjs',
    name: 'Next.js',
    packages: ['next'],
    webDir: 'out',
    buildCommand: 'next build',
    staticByDefault: false,
    steps: [
      'Set output: \'export\' in next.config.* so next build writes a static out/ folder.',
      'Set images: { unoptimized: true } (or a custom loader): the default next/image loader needs a server.',
      'Give every dynamic route generateStaticParams(), or move it to a client route that reads a query string.',
      'Move API routes, middleware/proxy, server actions, getServerSideProps and cookies()/headers() reads to a hosted API called over HTTPS.',
      BASE_PATH_NOTE,
      ROUTING_NOTE,
    ],
    serverFeatures: ['app/api/', 'pages/api/', 'middleware.ts / proxy.ts', '\'use server\'', 'getServerSideProps', 'cookies() / headers()'],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    packages: ['nuxt'],
    webDir: '.output/public',
    buildCommand: 'nuxt generate',
    staticByDefault: false,
    steps: [
      'Set ssr: false in nuxt.config.* for the mobile build.',
      'Build with nuxt generate (npx nuxi generate); it writes .output/public/index.html.',
      'Move server/api and server/routes handlers to a hosted API.',
      ENV_NOTE,
    ],
    serverFeatures: ['server/api/', 'server/routes/', 'useRequestHeaders / useCookie on the server'],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    packages: ['@sveltejs/kit'],
    webDir: 'build',
    buildCommand: 'vite build',
    staticByDefault: false,
    steps: [
      'Install @sveltejs/adapter-static and configure adapter({ fallback: \'index.html\' }).',
      'Add export const ssr = false in src/routes/+layout.ts so the app runs as an SPA.',
      'Move +page.server.ts, +layout.server.ts and +server.ts logic to a hosted API.',
      ROUTING_NOTE,
    ],
    serverFeatures: ['+page.server.ts', '+layout.server.ts', '+server.ts', 'hooks.server.ts'],
  },
  {
    id: 'angular',
    name: 'Angular',
    packages: ['@angular/core'],
    webDir: 'dist/<project>/browser',
    buildCommand: 'ng build',
    staticByDefault: true,
    steps: [
      'Use the application builder and set webDir to dist/<project>/browser (replace <project> with the angular.json project name).',
      'Remove @angular/ssr server output for the mobile build (outputMode static, no server entry).',
      'Keep <base href="/"> in index.html.',
    ],
    serverFeatures: ['@angular/ssr', 'server.ts'],
  },
  {
    id: 'react_router',
    name: 'React Router (framework mode)',
    packages: ['@react-router/dev'],
    webDir: 'build/client',
    buildCommand: 'react-router build',
    staticByDefault: false,
    steps: [
      'Set ssr: false in react-router.config.ts (SPA mode); the build writes build/client/index.html.',
      'Replace server loader/action exports with clientLoader/clientAction calling a hosted API.',
      ROUTING_NOTE,
    ],
    serverFeatures: ['loader / action exports', 'entry.server.tsx', 'resource routes'],
  },
  {
    id: 'remix',
    name: 'Remix v2',
    packages: ['@remix-run/react', '@remix-run/dev'],
    webDir: 'build/client',
    buildCommand: 'remix vite:build',
    staticByDefault: false,
    steps: [
      'Remix v2 is superseded by React Router v7: migrate, then use SPA mode (ssr: false). Remix v2 SPA mode also writes build/client.',
      'Replace server loaders and actions with client loaders calling a hosted API.',
    ],
    serverFeatures: ['loader / action exports', 'entry.server.tsx'],
  },
  {
    id: 'astro',
    name: 'Astro',
    packages: ['astro'],
    webDir: 'dist',
    buildCommand: 'astro build',
    staticByDefault: true,
    steps: [
      'Keep output: \'static\' and remove server adapters (@astrojs/node, @astrojs/vercel, ...) from the mobile build.',
      'Astro is multi-page and Capacitor will not serve about/index.html for /about: use one page with a client router (React/Vue/Svelte island) or client-side routing, and test every navigation on a device.',
    ],
    serverFeatures: ['output: \'server\'', 'src/pages/api/', 'Astro actions'],
  },
  {
    id: 'solidstart',
    name: 'SolidStart',
    packages: ['@solidjs/start'],
    webDir: '.output/public',
    buildCommand: 'vinxi build',
    staticByDefault: false,
    steps: [
      'Set ssr: false and a static preset in app.config.*; confirm the output folder contains index.html (usually .output/public).',
      'Move server functions ("use server") to a hosted API.',
    ],
    serverFeatures: ['\'use server\'', 'src/routes/api/'],
  },
  {
    id: 'qwik',
    name: 'Qwik City',
    packages: ['@builder.io/qwik-city', '@qwik.dev/router'],
    webDir: 'dist',
    buildCommand: 'qwik build',
    staticByDefault: false,
    steps: [
      'Add the static adapter (npm run qwik add static); output is dist.',
      'Move routeLoader$/routeAction$ server code to a hosted API.',
      ROUTING_NOTE,
    ],
    serverFeatures: ['routeLoader$', 'routeAction$', 'server$'],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    packages: ['gatsby'],
    webDir: 'public',
    buildCommand: 'gatsby build',
    staticByDefault: true,
    steps: [
      'gatsby build writes public/. Remove SSR (getServerData) and Gatsby Functions from the mobile build.',
      'Gatsby pages are separate HTML files: keep navigation on Gatsby Link (client-side) and test reloads on a device.',
    ],
    serverFeatures: ['getServerData', 'src/api/'],
  },
  {
    id: 'create_react_app',
    name: 'Create React App',
    packages: ['react-scripts'],
    webDir: 'build',
    buildCommand: 'react-scripts build',
    staticByDefault: true,
    steps: [
      'react-scripts build already writes build/index.html. Set "homepage": "." only if assets fail to load.',
      'Create React App is deprecated; plan a move to Vite when convenient.',
    ],
    serverFeatures: [],
  },
  {
    id: 'vue_cli',
    name: 'Vue CLI',
    packages: ['@vue/cli-service'],
    webDir: 'dist',
    buildCommand: 'vue-cli-service build',
    staticByDefault: true,
    steps: ['vue-cli-service build writes dist/index.html. Keep publicPath at /.'],
    serverFeatures: [],
  },
  {
    id: 'vite',
    name: 'Vite SPA',
    packages: ['vite'],
    webDir: 'dist',
    buildCommand: 'vite build',
    staticByDefault: true,
    steps: ['vite build writes dist/index.html. Keep base at / and the dev server reachable on the LAN for live reload (server.host: true).', ENV_NOTE],
    serverFeatures: [],
  },
  {
    id: 'static_html',
    name: 'Static HTML',
    packages: [],
    webDir: 'www',
    buildCommand: '',
    staticByDefault: true,
    steps: ['Put index.html and its assets in one folder (www by default) and use that folder as webDir. Use relative or root-based asset paths.'],
    serverFeatures: [],
  },
  {
    id: 'unknown',
    name: 'Unknown framework',
    packages: [],
    webDir: 'dist',
    buildCommand: 'build',
    staticByDefault: false,
    steps: [
      'Find the production build command and the folder it writes; that folder must contain index.html at its root and becomes webDir.',
      'If the build needs a running Node server (SSR, API routes), switch it to static/SPA output and move server code to a hosted API.',
    ],
    serverFeatures: ['API routes', 'server-side rendering', 'server middleware'],
  },
]

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

function installCommand(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn install' : `${pm} install`
}

// ---------------------------------------------------------------------------
// App identity
// ---------------------------------------------------------------------------

const APP_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/i
const PLACEHOLDER_APP_IDS = new Set(['com.example.app', 'io.ionic.starter', 'com.company.app', 'com.capacitorjs.app'])
const JAVA_KEYWORDS = new Set(['abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'])

export function appIdProblem(appId: string): string | null {
  if (!APP_ID_PATTERN.test(appId))
    return 'Use reverse-domain segments of letters, digits and underscores, each starting with a letter, such as com.yourcompany.yourapp. Android rejects hyphens.'
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

export function suggestAppId(input: { appId?: string, websiteUrl?: string, appName?: string }) {
  const warnings: string[] = []
  if (input.appId) {
    const problem = appIdProblem(input.appId)
    if (!problem)
      return { app_id: input.appId, source: 'input' as const, warnings }
    warnings.push(`appId ${input.appId}: ${problem}`)
  }
  if (input.websiteUrl) {
    try {
      const host = new URL(input.websiteUrl).hostname.replace(/^www\./, '')
      const labels = host.split('.').filter(Boolean).map(slug)
      if (labels.length >= 2) {
        const reversed = labels.reverse()
        const segments = reversed.length === 2 ? [...reversed, input.appName ? slug(input.appName) : 'app'] : reversed
        const candidate = segments.map(segment => (JAVA_KEYWORDS.has(segment) ? `${segment}app` : segment)).join('.')
        if (!appIdProblem(candidate)) {
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

export const MOBILE_FEATURES = [
  'camera',
  'files',
  'push_notifications',
  'local_notifications',
  'geolocation',
  'background_location',
  'biometric_login',
  'social_login',
  'passkeys',
  'in_app_purchases',
  'native_payments',
  'deep_links',
  'offline',
  'sqlite',
  'share',
  'receive_shares',
  'haptics',
  'barcode_scanner',
  'document_scanner',
  'in_app_browser',
  'maps',
  'contacts',
  'calendar',
  'health',
  'bluetooth',
  'nfc',
  'audio',
  'video',
  'speech_recognition',
  'app_review_prompt',
  'ads',
  'native_navigation',
  'live_updates',
] as const
export type MobileFeature = typeof MOBILE_FEATURES[number]

interface PluginSpec {
  package: string
  publisher: 'capacitor' | 'capgo'
  purpose: string
  docsUrl: string
  iosUsageKeys?: string[]
  iosCapabilities?: string[]
  androidPermissions?: string[]
  notes?: string[]
  storeNotes?: string[]
  checklist?: string[]
  skill?: SkillName
  alternatives?: string[]
}

const official = (name: string) => `https://capacitorjs.com/docs/apis/${name}`
const capgo = (name: string) => `https://capgo.app/docs/plugins/${name}/`

const PLUGINS: Record<MobileFeature, PluginSpec[]> = {
  camera: [{
    package: '@capacitor/camera',
    publisher: 'capacitor',
    purpose: 'Take photos and pick images or videos from the library.',
    docsUrl: official('camera'),
    iosUsageKeys: ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription'],
    notes: ['Ask for camera access when the user taps the capture button, not on launch.', 'Also add NSPhotoLibraryAddUsageDescription when the app saves photos to the library.'],
    alternatives: ['@capgo/camera-preview for a custom in-app camera view with overlays.'],
  }],
  files: [
    {
      package: '@capacitor/filesystem',
      publisher: 'capacitor',
      purpose: 'Read and write files in the app sandbox.',
      docsUrl: official('filesystem'),
    },
    {
      package: '@capgo/capacitor-file-picker',
      publisher: 'capgo',
      purpose: 'Let the user pick files, images, videos or folders from the device.',
      docsUrl: capgo('file-picker'),
    },
  ],
  push_notifications: [{
    package: '@capgo/capacitor-notifications',
    publisher: 'capgo',
    purpose: 'Native iOS and Android push with Capgo campaigns, stats, badges and silent live-update checks.',
    docsUrl: capgo('notifications'),
    iosCapabilities: ['Push Notifications', 'Background Modes > Remote notifications'],
    androidPermissions: ['android.permission.POST_NOTIFICATIONS (runtime prompt on Android 13+)'],
    notes: [
      'Run npx @capgo/cli@latest notifications setup <appId> from the app folder, then add the platform credentials in the Capgo console Notifications tab.',
      'Mint identity proofs on your backend; never ship a Capgo API key in the app.',
    ],
    skill: 'capacitor-push-notifications',
    alternatives: ['@capacitor/push-notifications with your own APNs/FCM backend.'],
  }],
  local_notifications: [{
    package: '@capacitor/local-notifications',
    publisher: 'capacitor',
    purpose: 'Schedule notifications on the device without a server.',
    docsUrl: official('local-notifications'),
    androidPermissions: ['android.permission.POST_NOTIFICATIONS (runtime prompt on Android 13+)', 'android.permission.SCHEDULE_EXACT_ALARM only for exact alarms (ask the user first; Play reviews it)'],
  }],
  geolocation: [{
    package: '@capacitor/geolocation',
    publisher: 'capacitor',
    purpose: 'Read the device location while the app is open.',
    docsUrl: official('geolocation'),
    iosUsageKeys: ['NSLocationWhenInUseUsageDescription'],
    androidPermissions: ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'],
  }],
  background_location: [{
    package: '@capgo/background-geolocation',
    publisher: 'capgo',
    purpose: 'Track location and geofences while the app is in the background.',
    docsUrl: capgo('background-geolocation'),
    iosUsageKeys: ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription'],
    iosCapabilities: ['Background Modes > Location updates'],
    androidPermissions: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.FOREGROUND_SERVICE_LOCATION'],
    storeNotes: [
      'Google Play requires the background location permission declaration and a video showing the feature.',
      'Apple asks why "Always" access is needed; explain the user benefit in the purpose string and review notes.',
    ],
    checklist: ['google.permission_declarations'],
  }],
  biometric_login: [{
    package: '@capgo/capacitor-native-biometric',
    publisher: 'capgo',
    purpose: 'Face ID, Touch ID and Android biometrics, plus secure credential storage.',
    docsUrl: capgo('native-biometric'),
    iosUsageKeys: ['NSFaceIDUsageDescription'],
    androidPermissions: ['android.permission.USE_BIOMETRIC'],
  }],
  social_login: [{
    package: '@capgo/capacitor-social-login',
    publisher: 'capgo',
    purpose: 'Native Sign in with Apple, Google and Facebook (web OAuth redirects do not work inside the app).',
    docsUrl: capgo('social-login'),
    iosCapabilities: ['Sign in with Apple'],
    storeNotes: ['Apple 4.8: when you offer third-party login on iOS, also offer Sign in with Apple or an equivalent privacy-preserving login.'],
    checklist: ['apple.login_services', 'native.auth_redirects'],
  }],
  passkeys: [{
    package: '@capgo/capacitor-passkey',
    publisher: 'capgo',
    purpose: 'Passkeys with a WebAuthn-style API.',
    docsUrl: capgo('passkey'),
    iosCapabilities: ['Associated Domains (webcredentials:<your domain>)'],
    notes: ['Host apple-app-site-association and assetlinks.json on the relying party domain.'],
  }],
  in_app_purchases: [{
    package: '@capgo/native-purchases',
    publisher: 'capgo',
    purpose: 'StoreKit and Google Play Billing subscriptions and one-time purchases.',
    docsUrl: capgo('native-purchases'),
    iosCapabilities: ['In-App Purchase'],
    storeNotes: [
      'Apple 3.1.1 and Google Play Payments policy: digital goods and subscriptions used in the app go through store billing unless an exemption applies.',
      'Hide web checkout for digital goods in the store builds where it is not allowed; offer Restore Purchases.',
    ],
    skill: 'subscription-app-revenue',
    checklist: ['apple.in_app_purchase', 'google.play_billing'],
  }],
  native_payments: [{
    package: '@capgo/capacitor-pay',
    publisher: 'capgo',
    purpose: 'Apple Pay and Google Pay for physical goods and real-world services.',
    docsUrl: capgo('pay'),
    iosCapabilities: ['Apple Pay (merchant ID)'],
    storeNotes: ['Only for physical goods and services; digital goods need store billing (see in_app_purchases).'],
    alternatives: ['@capgo/capacitor-stripe-pay for the Stripe Payment Sheet.'],
  }],
  deep_links: [{
    package: '@capacitor/app',
    publisher: 'capacitor',
    purpose: 'Receive universal links and App Links with App.addListener(\'appUrlOpen\', ...).',
    docsUrl: official('app'),
    iosCapabilities: ['Associated Domains (applinks:<your domain>)'],
    notes: ['Host /.well-known/apple-app-site-association and /.well-known/assetlinks.json; add an Android intent filter with android:autoVerify="true".'],
    skill: 'capacitor-deep-linking',
  }],
  offline: [
    {
      package: '@capacitor/network',
      publisher: 'capacitor',
      purpose: 'Detect connectivity changes to show offline states.',
      docsUrl: official('network'),
      skill: 'capacitor-offline-first',
    },
    {
      package: '@capacitor/preferences',
      publisher: 'capacitor',
      purpose: 'Persistent key-value storage that survives WebView storage eviction.',
      docsUrl: official('preferences'),
    },
  ],
  sqlite: [{
    package: '@capgo/capacitor-fast-sql',
    publisher: 'capgo',
    purpose: 'Fast native SQLite for offline data and IndexedDB replacement.',
    docsUrl: capgo('fast-sql'),
  }],
  share: [{
    package: '@capacitor/share',
    publisher: 'capacitor',
    purpose: 'Open the native share sheet.',
    docsUrl: official('share'),
  }],
  receive_shares: [{
    package: '@capgo/capacitor-share-target',
    publisher: 'capgo',
    purpose: 'Receive text, links and files shared from other apps.',
    docsUrl: capgo('share-target'),
  }],
  haptics: [{
    package: '@capacitor/haptics',
    publisher: 'capacitor',
    purpose: 'Native haptic feedback on taps and confirmations.',
    docsUrl: official('haptics'),
  }],
  barcode_scanner: [{
    package: '@capacitor/barcode-scanner',
    publisher: 'capacitor',
    purpose: 'Scan QR codes and barcodes with the camera.',
    docsUrl: official('barcode-scanner'),
    iosUsageKeys: ['NSCameraUsageDescription'],
    notes: ['Needs minSdkVersion 26 in android/variables.gradle on Capacitor 8 (ask before raising it).'],
  }],
  document_scanner: [{
    package: '@capgo/capacitor-document-scanner',
    publisher: 'capgo',
    purpose: 'Scan documents with edge detection.',
    docsUrl: capgo('document-scanner'),
    iosUsageKeys: ['NSCameraUsageDescription'],
  }],
  in_app_browser: [{
    package: '@capacitor/browser',
    publisher: 'capacitor',
    purpose: 'Open external pages and OAuth flows in SFSafariViewController / Custom Tabs instead of the app WebView.',
    docsUrl: official('browser'),
    alternatives: ['@capgo/capacitor-inappbrowser when you need JavaScript injection, postMessage or screenshots.'],
  }],
  maps: [{
    package: '@capgo/capacitor-native-map',
    publisher: 'capgo',
    purpose: 'Native maps: Apple MapKit on iOS, Google Maps on Android.',
    docsUrl: capgo('native-map'),
    notes: ['Android needs a Google Maps API key in AndroidManifest.xml.'],
    alternatives: ['@capacitor/google-maps for Google Maps on both platforms.'],
  }],
  contacts: [{
    package: '@capacitor/contacts',
    publisher: 'capacitor',
    purpose: 'Read and write device contacts.',
    docsUrl: official('contacts'),
    iosUsageKeys: ['NSContactsUsageDescription'],
    androidPermissions: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS (only when writing)'],
    alternatives: ['@capgo/capacitor-contacts.'],
  }],
  calendar: [{
    package: '@capacitor/calendar',
    publisher: 'capacitor',
    purpose: 'Create and read calendar events.',
    docsUrl: official('calendar'),
    iosUsageKeys: ['NSCalendarsFullAccessUsageDescription or NSCalendarsWriteOnlyAccessUsageDescription'],
    androidPermissions: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
    alternatives: ['@capgo/capacitor-calendar (adds iOS reminders).'],
  }],
  health: [{
    package: '@capgo/capacitor-health',
    publisher: 'capgo',
    purpose: 'Apple HealthKit and Android Health Connect data.',
    docsUrl: capgo('health'),
    iosUsageKeys: ['NSHealthShareUsageDescription', 'NSHealthUpdateUsageDescription'],
    iosCapabilities: ['HealthKit'],
    androidPermissions: ['Health Connect permissions for each data type (android.permission.health.READ_*)'],
    storeNotes: ['Apple 5.1.3 and the Play Health Connect declaration limit how health data may be used; never use it for ads.'],
    checklist: ['apple.health_data', 'google.permission_declarations'],
    alternatives: ['@capacitor/health-fitness.'],
  }],
  bluetooth: [{
    package: '@capgo/capacitor-bluetooth-low-energy',
    publisher: 'capgo',
    purpose: 'Scan, connect, read, write and subscribe to BLE devices.',
    docsUrl: capgo('bluetooth-low-energy'),
    iosUsageKeys: ['NSBluetoothAlwaysUsageDescription'],
    androidPermissions: ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT'],
  }],
  nfc: [{
    package: '@capgo/capacitor-nfc',
    publisher: 'capgo',
    purpose: 'Read and write NFC tags.',
    docsUrl: capgo('nfc'),
    iosUsageKeys: ['NFCReaderUsageDescription'],
    iosCapabilities: ['Near Field Communication Tag Reading'],
    androidPermissions: ['android.permission.NFC'],
  }],
  audio: [{
    package: '@capgo/capacitor-native-audio',
    publisher: 'capgo',
    purpose: 'Low-latency native audio, playlists and background playback.',
    docsUrl: capgo('native-audio'),
    iosCapabilities: ['Background Modes > Audio (only for background playback)'],
  }],
  video: [{
    package: '@capgo/capacitor-video-player',
    publisher: 'capgo',
    purpose: 'Play video in the native player with fullscreen and picture-in-picture.',
    docsUrl: capgo('video-player'),
  }],
  speech_recognition: [{
    package: '@capgo/capacitor-speech-recognition',
    publisher: 'capgo',
    purpose: 'On-device speech recognition with live results.',
    docsUrl: capgo('speech-recognition'),
    iosUsageKeys: ['NSSpeechRecognitionUsageDescription', 'NSMicrophoneUsageDescription'],
    androidPermissions: ['android.permission.RECORD_AUDIO'],
  }],
  app_review_prompt: [{
    package: '@capgo/capacitor-in-app-review',
    publisher: 'capgo',
    purpose: 'Ask for a store rating without leaving the app.',
    docsUrl: capgo('in-app-review'),
    storeNotes: ['Apple 3.2.1(x)/5.6.1: use the system prompt only; never gate features behind a review.'],
  }],
  ads: [
    {
      package: '@capgo/capacitor-admob',
      publisher: 'capgo',
      purpose: 'Google AdMob banners, interstitials and rewarded ads.',
      docsUrl: capgo('admob'),
      storeNotes: ['Declare ads in App Privacy and Data safety; never show ads in Kids category apps.'],
    },
    {
      package: '@capgo/capacitor-app-tracking-transparency',
      publisher: 'capgo',
      purpose: 'Show the iOS App Tracking Transparency prompt before tracking.',
      docsUrl: capgo('app-tracking-transparency'),
      iosUsageKeys: ['NSUserTrackingUsageDescription'],
      storeNotes: ['Apple 5.1.2: ask through ATT before any cross-app tracking or IDFA access.'],
      checklist: ['apple.tracking_transparency'],
    },
  ],
  native_navigation: [
    {
      package: '@capgo/capacitor-native-navigation',
      publisher: 'capgo',
      purpose: 'Native navigation bar, tab bar and safe areas around your web views.',
      docsUrl: capgo('native-navigation'),
      notes: ['Gives a website a real app shell, which helps against Apple 4.2 (minimum functionality).'],
    },
    {
      package: '@capgo/capacitor-transitions',
      publisher: 'capgo',
      purpose: 'iOS-style page transitions between routes.',
      docsUrl: capgo('transitions'),
    },
  ],
  live_updates: [{
    package: '@capgo/capacitor-updater',
    publisher: 'capgo',
    purpose: 'Capgo live updates: ship web fixes without a store release, with channels and automatic rollback.',
    docsUrl: capgo('updater'),
    notes: [
      'Prefer npx @capgo/cli@latest init (the user runs it; it is interactive). Manual setup: install the plugin, call CapacitorUpdater.notifyAppReady() at startup, then npx cap sync.',
      'Live updates change web assets only. Native code, plugins, permissions and icons still need a store release.',
    ],
    storeNotes: ['Apple 2.5.2 and Google Play Device and Network Abuse policy: live updates may change interpreted web code only and must not change the app\'s primary purpose.'],
    skill: 'capgo-live-updates',
    checklist: ['release.live_update_policy'],
  }],
}

/** Plugins every Capacitor app benefits from. */
const BASELINE_PLUGINS: PluginSpec[] = [
  {
    package: '@capacitor/app',
    publisher: 'capacitor',
    purpose: 'App lifecycle, Android back button and deep link events.',
    docsUrl: official('app'),
  },
  {
    package: '@capacitor/splash-screen',
    publisher: 'capacitor',
    purpose: 'Control the launch screen so there is no white flash.',
    docsUrl: official('splash-screen'),
    skill: 'capacitor-splash-screen',
  },
  {
    package: '@capacitor/keyboard',
    publisher: 'capacitor',
    purpose: 'Keyboard events and resize behaviour so inputs are never hidden.',
    docsUrl: official('keyboard'),
    skill: 'capacitor-keyboard',
  },
]

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

export const CHECKLIST_TOPICS = ['design', 'native', 'apple_review', 'google_play', 'release'] as const
export type ChecklistTopic = typeof CHECKLIST_TOPICS[number]
export const SEVERITIES = ['blocker', 'required', 'recommended'] as const
export type Severity = typeof SEVERITIES[number]

export const APP_TRAITS = [
  'accounts',
  'third_party_login',
  'digital_goods',
  'physical_goods',
  'user_generated_content',
  'kids',
  'health_data',
  'location',
  'push',
  'ads_or_tracking',
  'ai_features',
  'personal_play_account',
] as const
export type AppTrait = typeof APP_TRAITS[number]

interface ChecklistSpec {
  id: string
  topic: ChecklistTopic
  severity: Severity
  platforms: readonly Platform[]
  title: string
  rule: string
  check: string[]
  fix: string
  skill?: SkillName
  docsUrl?: string
  /** Only listed when one of these traits is set. */
  when?: AppTrait[]
}

const BOTH = PLATFORMS
const IOS = ['ios'] as const
const ANDROID = ['android'] as const

export const CHECKLIST: readonly ChecklistSpec[] = [
  // Design: what makes a wrapped website feel like an app (and survives Apple 4.2).
  {
    id: 'design.viewport_fit_cover',
    topic: 'design',
    severity: 'blocker',
    platforms: BOTH,
    title: 'Viewport covers the whole screen',
    rule: 'index.html must use <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">. Without viewport-fit=cover, env(safe-area-inset-*) is 0 on iOS and Capacitor pads the WebView on Android.',
    check: ['grep -n "viewport-fit=cover" index.html (or the framework\'s HTML template)'],
    fix: 'Add viewport-fit=cover to the viewport meta tag.',
    skill: 'safe-area-handling',
  },
  {
    id: 'design.safe_areas',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'Content stays clear of the notch, status bar and home indicator',
    rule: 'Pad the app shell once with var(--safe-area-inset-*, env(safe-area-inset-*, 0px)) for top, bottom, left and right. Never hardcode 20/44/47 px bar heights; use 100dvh instead of 100vh. Ionic and Konsta already pad: do not pad twice.',
    check: ['grep -rn "safe-area-inset" src', 'Run on an iPhone with Dynamic Island, an iPhone SE-size device and Android in gesture and 3-button navigation, portrait and landscape.'],
    fix: 'Define --sat/--sar/--sab/--sal from var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) (and the other sides) on :root and pad body with them; for full-bleed designs pad the fixed header and tab bar instead. Confirm with a device screenshot: a CSS rule that no element uses does not count.',
    skill: 'safe-area-handling',
  },
  {
    id: 'design.android_edge_to_edge',
    topic: 'design',
    severity: 'required',
    platforms: ANDROID,
    title: 'Android edge-to-edge (targetSdk 36) is handled',
    rule: 'Android 16 enforces edge-to-edge: @capacitor/status-bar overlaysWebView and backgroundColor have no effect and android.adjustMarginsForEdgeToEdge is removed in Capacitor 8. The core SystemBars plugin injects --safe-area-inset-* for WebView < 140.',
    check: ['grep -rn "adjustMarginsForEdgeToEdge\\|setOverlaysWebView\\|setBackgroundColor" capacitor.config.* src'],
    fix: 'Delete adjustMarginsForEdgeToEdge, draw the status bar background in CSS and set icon contrast with SystemBars.setStyle from @capacitor/core.',
    skill: 'safe-area-handling',
  },
  {
    id: 'design.keyboard',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'The keyboard never hides the focused input',
    rule: 'Forms stay usable with the keyboard open: the focused field scrolls into view, fixed footers move above the keyboard, and the iOS bottom safe area is not added on top of the keyboard height.',
    check: ['Open every form on a small phone and type in the last field.'],
    fix: 'Install @capacitor/keyboard, choose a resize mode (native/body/ionic) and scroll the focused input into view on keyboardDidShow.',
    skill: 'capacitor-keyboard',
  },
  {
    id: 'design.app_navigation',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'Navigation works like an app',
    rule: 'Use app navigation (tab bar or stack with a back affordance), not a website header and footer. Android hardware back goes back in history and exits on the root screen; iOS swipe-back does not break routing.',
    check: ['grep -rn "backButton" src', 'Press Android back on a nested screen and on the home screen.'],
    fix: 'App.addListener(\'backButton\', ({ canGoBack }) => canGoBack ? history.back() : App.exitApp()) from @capacitor/app; consider @capgo/capacitor-native-navigation for a native tab bar.',
  },
  {
    id: 'design.touch_targets',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'Touch-first controls',
    rule: 'Tap targets are at least 44x44 pt (iOS) / 48x48 dp (Android); nothing depends on hover; inputs use the right type/inputmode so the correct keyboard opens.',
    check: ['Audit buttons, icon links and menus at phone width with a touch device.'],
    fix: 'Enlarge hit areas with padding, replace hover menus with tap menus, set input type="email", "tel", inputmode="numeric" where relevant.',
  },
  {
    id: 'design.no_web_chrome',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'No website-only chrome inside the app',
    rule: 'Remove "install this app" and PWA install prompts, "download our app" and app store banners, website footers and sitemaps, and links that leave the app for the same website.',
    check: ['grep -rn "beforeinstallprompt\\|apps.apple.com\\|play.google.com" src'],
    fix: 'Hide these blocks when Capacitor.isNativePlatform() is true.',
    skill: 'webapp-to-capacitor',
  },
  {
    id: 'design.external_links',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'External links leave the WebView',
    rule: 'Third-party pages and OAuth flows open in the system browser or @capacitor/browser, never inside the app WebView (which would replace the app and has no back button).',
    check: ['grep -rn "target=\\"_blank\\"\\|window.open" src'],
    fix: 'Route external URLs through Browser.open({ url }) from @capacitor/browser.',
  },
  {
    id: 'design.offline_and_errors',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'Offline and error states, never a browser error page',
    rule: 'With no network the app still opens and shows an app-styled offline or retry state; failed API calls show a message, not a blank screen.',
    check: ['Enable airplane mode, cold-start the app and navigate.'],
    fix: 'Listen to @capacitor/network status, cache the last data locally and render an offline screen.',
    skill: 'capacitor-offline-first',
  },
  {
    id: 'design.icon_and_splash',
    topic: 'design',
    severity: 'required',
    platforms: BOTH,
    title: 'Real app icon and splash screen',
    rule: 'Ship your own icon (1024x1024 source, no transparency on iOS) and a splash screen matching the first screen\'s background, so there is no default Capacitor icon and no white flash.',
    check: ['Look for the default Capacitor icon in ios/App/App/Assets.xcassets and android/app/src/main/res/mipmap-*.'],
    fix: 'Put icon-only.png, icon-foreground.png, icon-background.png, splash.png and splash-dark.png in assets/ and run npx @capacitor/assets generate.',
    skill: 'capacitor-splash-screen',
  },
  {
    id: 'design.native_feel',
    topic: 'design',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Small details that read as native',
    rule: 'No rubber-band page bounce exposing a blank background (overscroll-behavior: none on the scroll root), no grey tap highlight (-webkit-tap-highlight-color: transparent), no text selection on buttons and nav (user-select: none), haptics on key actions.',
    check: ['Scroll past the top and bottom of each screen; long-press buttons.'],
    fix: 'Add the CSS rules on the app shell and @capacitor/haptics for confirmations.',
  },
  {
    id: 'design.dark_mode',
    topic: 'design',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Dark mode and status bar contrast',
    rule: 'Status bar icons stay readable on every screen and the app either supports prefers-color-scheme: dark or deliberately forces one theme.',
    check: ['Switch the device to dark mode and open each screen.'],
    fix: 'SystemBars.setStyle({ style: SystemBarsStyle.Dark | Light }) from @capacitor/core when the screen background changes.',
  },
  {
    id: 'design.accessibility',
    topic: 'design',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Accessible to VoiceOver and TalkBack',
    rule: 'Interactive elements have labels and roles, focus order follows the layout, text scales with the system setting and contrast meets WCAG AA.',
    check: ['Navigate the main flow with VoiceOver and TalkBack enabled.'],
    fix: 'Use semantic HTML, aria-labels on icon buttons, rem-based font sizes.',
    skill: 'capacitor-accessibility',
  },
  {
    id: 'design.tablets',
    topic: 'design',
    severity: 'recommended',
    platforms: IOS,
    title: 'iPad layouts or iPhone-only',
    rule: 'If the app supports iPad, layouts must work in every orientation and in windowed mode; otherwise ship iPhone-only (TARGETED_DEVICE_FAMILY = 1) so review does not test a broken iPad layout.',
    check: ['Run on an iPad simulator and rotate, or check TARGETED_DEVICE_FAMILY in the Xcode project.'],
    fix: 'Add responsive breakpoints or restrict the device family.',
    skill: 'capacitor-ios-resizability',
  },
  // Native project setup.
  {
    id: 'native.static_build',
    topic: 'native',
    severity: 'blocker',
    platforms: BOTH,
    title: 'Static build with index.html',
    rule: 'Capacitor copies webDir into the app and never runs Node: the build output must contain index.html at its root and must not depend on SSR, API routes, middleware or server actions at runtime.',
    check: ['Run the production build, then test -f <webDir>/index.html'],
    fix: 'Switch the framework to static/SPA output and move server code to a hosted API.',
    skill: 'framework-to-capacitor',
  },
  {
    id: 'native.bundled_assets',
    topic: 'native',
    severity: 'blocker',
    platforms: BOTH,
    title: 'Bundled web assets, no remote server.url',
    rule: 'Release builds load the bundled webDir. A server.url pointing at a website or a dev server is a thin web wrapper (Apple 4.2 risk), breaks offline and bypasses live updates.',
    check: ['grep -n "url" capacitor.config.* (look under server)'],
    fix: 'Remove server.url and server.cleartext from the release config; use npx cap run with -l/--live-reload during development instead.',
    skill: 'framework-to-capacitor',
  },
  {
    id: 'native.api_origins',
    topic: 'native',
    severity: 'required',
    platforms: BOTH,
    title: 'Backend accepts the app origins',
    rule: 'The app runs on capacitor://localhost (iOS) and https://localhost (Android). Cookies and localStorage from the website do not carry over.',
    check: ['Open Safari Web Inspector / chrome://inspect and look for CORS errors on API calls.'],
    fix: 'Allow both origins in CORS, or enable CapacitorHttp; use token-based sessions instead of cookies tied to the web origin.',
    skill: 'framework-to-capacitor',
  },
  {
    id: 'native.auth_redirects',
    topic: 'native',
    severity: 'required',
    platforms: BOTH,
    title: 'Login works without web redirects',
    rule: 'OAuth redirect URIs for the website do not return to the app. Use native provider SDKs or a system browser session with a custom scheme or universal link.',
    check: ['Sign in with every provider on a device build.'],
    fix: '@capgo/capacitor-social-login for Apple/Google/Facebook, or @capacitor/browser plus an appUrlOpen handler.',
    when: ['accounts', 'third_party_login'],
  },
  {
    id: 'native.permission_strings',
    topic: 'native',
    severity: 'blocker',
    platforms: BOTH,
    title: 'Permissions are declared, explained and requested in context',
    rule: 'Every iOS NS...UsageDescription a plugin can trigger is present with a specific purpose (missing keys crash the app and fail upload with ITMS-90683). Android permissions are only the ones needed. Ask at the moment of use and handle denial.',
    check: ['Compare plugin usage keys (capgo_recommend_plugins) with ios/App/App/Info.plist; review android/app/src/main/AndroidManifest.xml.'],
    fix: 'Add the missing keys with honest purpose strings and move permission prompts next to the feature.',
    skill: 'capacitor-plugins',
  },
  {
    id: 'native.service_worker',
    topic: 'native',
    severity: 'required',
    platforms: BOTH,
    title: 'Service worker disabled in the app build',
    rule: 'A web service worker can pin a stale bundle inside the app and fight live updates.',
    check: ['grep -rn "serviceWorker.register\\|vite-plugin-pwa\\|workbox" src vite.config.* next.config.*'],
    fix: 'Skip service worker registration when Capacitor.isNativePlatform() is true (or build the app without the PWA plugin).',
    skill: 'webapp-to-capacitor',
  },
  {
    id: 'native.deep_links',
    topic: 'native',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Links to your domain open the app',
    rule: 'Universal links (iOS) and verified App Links (Android) route to the right screen through appUrlOpen.',
    check: ['xcrun simctl openurl booted https://<domain>/<path> and adb shell am start -a android.intent.action.VIEW -d https://<domain>/<path>'],
    fix: 'Host apple-app-site-association and assetlinks.json, add Associated Domains and an autoVerify intent filter.',
    skill: 'capacitor-deep-linking',
  },
  {
    id: 'native.real_devices',
    topic: 'native',
    severity: 'required',
    platforms: BOTH,
    title: 'Tested on real devices',
    rule: 'Simulators do not prove camera, push, biometrics, Bluetooth, NFC, purchases or performance. Test each native feature on a physical iPhone and Android phone.',
    check: ['Run the critical flows on a device: login, logout, purchase/restore, offline, background/resume, kill and relaunch.'],
    fix: 'Use npx cap run ios/android with a connected device or a Capgo Cloud build installed through TestFlight / internal testing.',
    skill: 'capacitor-testing',
  },
  {
    id: 'native.live_updates',
    topic: 'native',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Live updates ready before the first store release',
    rule: '@capgo/capacitor-updater must be in the first store build so later web fixes ship without review. notifyAppReady() runs at startup or Capgo rolls the bundle back.',
    check: ['grep -rn "notifyAppReady" src', 'npx @capgo/cli@latest doctor'],
    fix: 'Run npx @capgo/cli@latest init in the app folder (interactive), or install @capgo/capacitor-updater and call CapacitorUpdater.notifyAppReady() in the entry file.',
    skill: 'capgo-live-updates',
  },
  // Apple App Review.
  {
    id: 'apple.developer_program',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'Apple Developer Program membership',
    rule: 'Publishing needs an Apple Developer Program membership (99 USD per year). Organization accounts need a D-U-N-S number; the account holder accepts agreements and sets up App Store Connect.',
    check: ['Ask the user whether they can sign in to App Store Connect with the Account Holder or Admin role.'],
    fix: 'Enroll at https://developer.apple.com/programs/enroll/ early: organization verification can take days.',
    docsUrl: 'https://developer.apple.com/programs/',
  },
  {
    id: 'apple.sdk_requirement',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'Built with the required Xcode and iOS SDK',
    rule: 'Since April 28, 2026 uploads must use Xcode 26+ and the iOS 26 SDK; from April 2027 Xcode 27 and the iOS 27 SDK, which require the UIScene lifecycle (Capacitor 8.5+).',
    check: ['xcodebuild -version locally, or use Capgo Cloud Build which runs the current Xcode.'],
    fix: 'Upgrade Xcode or build with Capgo Cloud Build; on Capacitor < 8.5 upgrade and apply the UIScene changes.',
    skill: 'capacitor-app-store',
    docsUrl: 'https://developer.apple.com/news/upcoming-requirements/',
  },
  {
    id: 'apple.minimum_functionality',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'More than a repackaged website (4.2)',
    rule: 'Apple rejects apps that are only a website in a WebView. Offer native value: push, offline use, device features (camera, biometrics, share), native navigation, widgets or app-only flows, and describe them in the review notes.',
    check: ['List the features that do not exist on the website. If there are none, say so to the user before investing in submission.'],
    fix: 'Add at least two native capabilities that serve the core use case and polish the design checklist items.',
    skill: 'capacitor-apple-review-preflight',
    docsUrl: 'https://developer.apple.com/app-store/review/guidelines/#minimum-functionality',
  },
  {
    id: 'apple.account_deletion',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'In-app account deletion (5.1.1(v))',
    rule: 'If users can create an account in the app, they must be able to start deleting it from inside the app (not only by email).',
    check: ['Find the delete-account entry point in the app settings.'],
    fix: 'Add a Delete account action that calls your backend and explains what is removed.',
    skill: 'webapp-to-capacitor',
    when: ['accounts'],
  },
  {
    id: 'apple.login_services',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'Sign in with Apple next to third-party login (4.8)',
    rule: 'When the app offers Google, Facebook or another third-party login, it must also offer Sign in with Apple or an equivalent login that limits data to name and email and lets users hide their email.',
    check: ['Open the login screen on iOS and list the providers.'],
    fix: 'Add Sign in with Apple with @capgo/capacitor-social-login and the Sign in with Apple capability.',
    when: ['third_party_login'],
  },
  {
    id: 'apple.in_app_purchase',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'Digital goods use In-App Purchase (3.1.1)',
    rule: 'Subscriptions, premium features, credits and other digital content consumed in the app use Apple In-App Purchase unless a documented exemption or entitlement applies. Physical goods and real-world services keep web payments.',
    check: ['List everything the app sells and where checkout happens on iOS.'],
    fix: 'Implement @capgo/native-purchases with Restore Purchases, or remove digital checkout from the iOS build.',
    skill: 'subscription-app-revenue',
    when: ['digital_goods'],
  },
  {
    id: 'apple.demo_account',
    topic: 'apple_review',
    severity: 'required',
    platforms: IOS,
    title: 'Demo account and review notes (2.1)',
    rule: 'Reviewers need a working demo account (or demo mode) and notes describing non-obvious and native features; backend services must be live during review.',
    check: ['Confirm a reviewer account exists that is not blocked by 2FA, region or invitation.'],
    fix: 'Create a dedicated demo account and fill App Review Information in App Store Connect.',
    when: ['accounts'],
  },
  {
    id: 'apple.privacy',
    topic: 'apple_review',
    severity: 'required',
    platforms: IOS,
    title: 'Privacy policy, App Privacy answers and privacy manifest',
    rule: 'Link a privacy policy in App Store Connect and inside the app (5.1.1(i)); App Privacy answers must match what the app and its SDKs collect; the app target ships PrivacyInfo.xcprivacy with every required-reason API (Capgo updater: NSPrivacyAccessedAPICategoryUserDefaults, reason CA92.1).',
    check: ['find ios -name PrivacyInfo.xcprivacy', 'Read the last upload email for ITMS-91053 / ITMS-91061 warnings.'],
    fix: 'Add PrivacyInfo.xcprivacy to the App target and complete App Privacy in App Store Connect.',
    skill: 'capacitor-app-store',
  },
  {
    id: 'apple.tracking_transparency',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'App Tracking Transparency before tracking (5.1.2)',
    rule: 'Cross-app tracking, ad attribution and IDFA access require the ATT prompt with NSUserTrackingUsageDescription, shown before any tracking SDK starts.',
    check: ['List analytics and ad SDKs and when they initialize.'],
    fix: '@capgo/capacitor-app-tracking-transparency, then start tracking SDKs only after authorization.',
    when: ['ads_or_tracking'],
  },
  {
    id: 'apple.user_generated_content',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'Moderation for user-generated content (1.2)',
    rule: 'Apps with user posts, chat or profiles need a way to report content, block users, filter objectionable material and contact the developer.',
    check: ['Find report and block actions on posts and profiles.'],
    fix: 'Add report/block actions and a moderation process, and mention it in the review notes.',
    when: ['user_generated_content'],
  },
  {
    id: 'apple.kids',
    topic: 'apple_review',
    severity: 'blocker',
    platforms: IOS,
    title: 'Kids category rules (1.3)',
    rule: 'Apps for children must not include third-party analytics or advertising that collects data, and links out or purchases need a parental gate.',
    check: ['List every SDK in the app and what it sends.'],
    fix: 'Remove tracking and ad SDKs and add a parental gate.',
    skill: 'capacitor-apple-review-preflight',
    when: ['kids'],
  },
  {
    id: 'apple.health_data',
    topic: 'apple_review',
    severity: 'required',
    platforms: IOS,
    title: 'Health data rules (5.1.3)',
    rule: 'HealthKit data must not be used for advertising or sold, and must not be stored in iCloud; explain the use in the purpose strings.',
    check: ['Trace where health data is sent and stored.'],
    fix: 'Keep health data for the user-facing feature only and document it in the privacy policy.',
    when: ['health_data'],
  },
  {
    id: 'apple.ai_disclosure',
    topic: 'apple_review',
    severity: 'required',
    platforms: IOS,
    title: 'Disclose third-party AI processing (5.1.2(i))',
    rule: 'Personal data sent to a third-party AI service must be disclosed in the app with explicit permission.',
    check: ['Find every call that sends user content to an AI provider.'],
    fix: 'Add an in-app disclosure and consent before the first request.',
    when: ['ai_features'],
  },
  {
    id: 'apple.listing',
    topic: 'apple_review',
    severity: 'required',
    platforms: IOS,
    title: 'Store listing, age rating and export compliance',
    rule: 'App name up to 30 characters, screenshots that show the app in use (not only a login or splash), support URL, the updated age rating questionnaire, and an export compliance answer (set ITSAppUsesNonExemptEncryption to false when only standard HTTPS is used).',
    check: ['Review App Store Connect > App Information and the version page before submitting.'],
    fix: 'Prepare screenshots for the required iPhone sizes and answer the questionnaires.',
    skill: 'capacitor-app-store',
  },
  // Google Play.
  {
    id: 'google.developer_account',
    topic: 'google_play',
    severity: 'blocker',
    platforms: ANDROID,
    title: 'Google Play developer account',
    rule: 'Publishing needs a Play Console developer account (25 USD one-time) with verified identity; organization accounts need a D-U-N-S number.',
    check: ['Ask the user whether they can create apps in Play Console.'],
    fix: 'Register at https://play.google.com/console/signup and complete verification.',
    docsUrl: 'https://support.google.com/googleplay/android-developer/answer/6112435',
  },
  {
    id: 'google.target_api',
    topic: 'google_play',
    severity: 'blocker',
    platforms: ANDROID,
    title: 'Targets API level 36',
    rule: 'Since August 31, 2026 new apps and updates must target Android 16 (API 36). Capacitor 8 templates use compile and target SDK 36.',
    check: ['grep -n "targetSdkVersion" android/variables.gradle'],
    fix: 'Set targetSdkVersion and compileSdkVersion to 36 (upgrade Capacitor if the template is older).',
    skill: 'capacitor-app-store',
    docsUrl: 'https://developer.android.com/google/play/requirements/target-sdk',
  },
  {
    id: 'google.app_bundle',
    topic: 'google_play',
    severity: 'blocker',
    platforms: ANDROID,
    title: 'Signed Android App Bundle with Play App Signing',
    rule: 'New apps upload an AAB signed with an upload key and enroll in Play App Signing. Keep the keystore and passwords safe: losing them blocks updates until a key reset.',
    check: ['Confirm a release keystore exists outside the repository.'],
    fix: 'Build bundleRelease, or let Capgo Cloud Build sign and upload it (npx @capgo/cli@latest build init).',
    skill: 'capgo-native-builds',
  },
  {
    id: 'google.closed_testing',
    topic: 'google_play',
    severity: 'blocker',
    platforms: ANDROID,
    title: 'Closed test with 12 testers for 14 days',
    rule: 'Personal developer accounts created after November 13, 2023 must run a closed test with at least 12 opted-in testers for 14 consecutive days before applying for production access.',
    check: ['Check the account type and the closed testing track in Play Console.'],
    fix: 'Start the closed test as soon as the first build works; recruit testers early.',
    docsUrl: 'https://support.google.com/googleplay/android-developer/answer/14151465',
    when: ['personal_play_account'],
  },
  {
    id: 'google.data_safety',
    topic: 'google_play',
    severity: 'required',
    platforms: ANDROID,
    title: 'Data safety, content rating and app access',
    rule: 'Complete the Data safety form to match the app and its SDKs, the content rating questionnaire, the target audience, and App access with demo credentials when screens are behind login.',
    check: ['Review Play Console > Policy > App content.'],
    fix: 'Answer every App content section before sending the first release for review.',
    skill: 'capacitor-app-store',
  },
  {
    id: 'google.account_deletion',
    topic: 'google_play',
    severity: 'blocker',
    platforms: ANDROID,
    title: 'Account deletion in the app and on the web',
    rule: 'Apps that let users create accounts must offer deletion inside the app and through a web link declared in the Data safety form.',
    check: ['Find the in-app delete action and a public deletion URL.'],
    fix: 'Add both and declare the URL in Play Console.',
    when: ['accounts'],
  },
  {
    id: 'google.play_billing',
    topic: 'google_play',
    severity: 'blocker',
    platforms: ANDROID,
    title: 'Digital goods use Google Play Billing',
    rule: 'Digital goods and subscriptions sold in the app use Google Play Billing unless a program such as alternative billing applies in the user\'s region.',
    check: ['List what the Android build sells and how.'],
    fix: 'Use @capgo/native-purchases, or remove digital checkout from the Android build.',
    skill: 'subscription-app-revenue',
    when: ['digital_goods'],
  },
  {
    id: 'google.permission_declarations',
    topic: 'google_play',
    severity: 'required',
    platforms: ANDROID,
    title: 'Sensitive permission declarations',
    rule: 'Background location, Health Connect, exact alarms, SMS/call log and all-files access need a Play Console declaration (and sometimes a video) before review.',
    check: ['grep -n "uses-permission" android/app/src/main/AndroidManifest.xml'],
    fix: 'Remove permissions you do not need and fill the declarations for the rest.',
    when: ['location', 'health_data'],
  },
  {
    id: 'google.listing',
    topic: 'google_play',
    severity: 'required',
    platforms: ANDROID,
    title: 'Store listing assets',
    rule: '512x512 icon, 1024x500 feature graphic, phone screenshots that show the app in use, short and full descriptions, privacy policy URL.',
    check: ['Review Play Console > Grow > Store presence > Main store listing.'],
    fix: 'Prepare the assets from real app screens.',
    skill: 'capacitor-app-store',
  },
  // Release.
  {
    id: 'release.versioning',
    topic: 'release',
    severity: 'required',
    platforms: BOTH,
    title: 'Version and build numbers increase',
    rule: 'Each store upload needs a higher build number (iOS CURRENT_PROJECT_VERSION, Android versionCode); the marketing version matches on both platforms.',
    check: ['Read MARKETING_VERSION/CURRENT_PROJECT_VERSION in Xcode build settings and versionName/versionCode in android/app/build.gradle.'],
    fix: 'Bump them before every native build.',
    skill: 'capacitor-app-store',
  },
  {
    id: 'release.cloud_build',
    topic: 'release',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Native builds without a local Mac',
    rule: 'Capgo Cloud Build signs and builds iOS and Android from any machine or CI and can submit to TestFlight and Google Play. Signing secrets stay out of the chat.',
    check: ['capgo_get_build_credentials shows saved credentials for each platform.'],
    fix: 'The user runs npx @capgo/cli@latest build init once; then package with build zip and call capgo_request_build and capgo_start_build.',
    skill: 'capgo-native-builds',
    docsUrl: 'https://capgo.app/docs/builder/',
  },
  {
    id: 'release.live_update_policy',
    topic: 'release',
    severity: 'required',
    platforms: BOTH,
    title: 'Live updates stay within store rules',
    rule: 'Live updates may change interpreted web code and assets only and must not change the app\'s primary purpose (Apple 2.5.2 and the Developer Program License Agreement, Google Play Device and Network Abuse policy). Native code, plugins, permissions, entitlements and icons need a store release.',
    check: ['npx @capgo/cli@latest bundle releaseType <appId> --channel production prints OTA or native.'],
    fix: 'Ship native changes through a store build; use live updates for web fixes and content.',
    skill: 'capgo-live-updates',
  },
  {
    id: 'release.channels',
    topic: 'release',
    severity: 'recommended',
    platforms: BOTH,
    title: 'Channels, staged rollout and monitoring',
    rule: 'Test bundles on a non-default channel first, roll out progressively, watch update health, and keep the previous bundle ready for rollback.',
    check: ['capgo_list_channels and capgo_observe for the app.'],
    fix: 'Create staging and production channels with capgo_add_channel; use capgo_update_channel_rollout for staged rollouts.',
    skill: 'capgo-live-updates',
  },
]

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

export function checkReadiness(input: ReadinessInput, release: CapacitorRelease) {
  const platforms: readonly Platform[] = input.platforms?.length ? input.platforms : PLATFORMS
  const packages = input.packages
  const config = input.capacitorConfig
  const project = input.project ?? {}
  const app = input.app ?? {}
  const traits = new Set(app.traits ?? [])
  const latestMajor = parseVersion(release.latest)?.[0] ?? 8
  const checks: ReadinessCheck[] = []
  const add = (check: Omit<ReadinessCheck, 'how_to_check' | 'checklist_id' | 'skill'> & { how_to_check?: string, checklist_id?: string, skill?: SkillName }) => {
    const item = check.checklist_id ? CHECKLIST_BY_ID.get(check.checklist_id) : undefined
    checks.push({
      ...check,
      how_to_check: check.status === 'unknown' ? (check.how_to_check ?? item?.check[0] ?? null) : null,
      checklist_id: check.checklist_id ?? null,
      skill: check.skill ?? item?.skill ?? null,
    })
  }
  const flag = (value: boolean | undefined, good: boolean) => (value === undefined ? 'unknown' as const : value === good ? 'pass' as const : 'fail' as const)

  // Capacitor packages.
  const core = parseVersion(packages?.['@capacitor/core'])
  if (!packages) {
    add({ id: 'capacitor.installed', status: 'unknown', severity: 'blocker', title: '@capacitor/core is installed', detail: 'Pass packages (dependencies and devDependencies from package.json) to check Capacitor.', fix: null, how_to_check: 'Read package.json dependencies and devDependencies.' })
  }
  else if (!core) {
    add({ id: 'capacitor.installed', status: 'fail', severity: 'blocker', title: '@capacitor/core is installed', detail: '@capacitor/core is missing or uses a version range without a number.', fix: 'Install @capacitor/core@latest and @capacitor/cli@latest (dev), then npx cap init.' })
  }
  else {
    add({ id: 'capacitor.installed', status: 'pass', severity: 'blocker', title: '@capacitor/core is installed', detail: `@capacitor/core ${packages['@capacitor/core']}.`, fix: null })
    const [major, minor] = core
    if (major < latestMajor) {
      add({ id: 'capacitor.latest_major', status: 'fail', severity: 'required', title: 'Capacitor is on the latest major', detail: `Capacitor ${major} is installed; the latest release is ${release.latest}.`, fix: `Upgrade every @capacitor/* package to ${latestMajor} (npx cap migrate after installing @capacitor/cli@latest) and the plugins to their matching major.`, skill: 'capacitor-app-upgrades' })
    }
    else {
      add({ id: 'capacitor.latest_major', status: 'pass', severity: 'required', title: 'Capacitor is on the latest major', detail: `Capacitor ${major} matches the latest release ${release.latest}.`, fix: null })
    }
    if (major === 8 && minor < 5) {
      add({ id: 'capacitor.uiscene_ready', status: 'warn', severity: 'required', title: 'Capacitor 8.5+ for Xcode 27', detail: 'Xcode 27 builds (required by Apple from April 2027) need the UIScene lifecycle that Capacitor 8.5 adds.', fix: 'Upgrade to the latest Capacitor 8 and apply the 8.5 UIScene project changes.', skill: 'capacitor-app-upgrades' })
    }
    const majors = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android']
      .filter(name => packages[name])
      .map(name => [name, parseVersion(packages[name])?.[0]] as const)
    const mismatched = majors.filter(([, value]) => value !== undefined && value !== major)
    add({
      id: 'capacitor.aligned',
      status: mismatched.length ? 'fail' : 'pass',
      severity: 'required',
      title: 'Capacitor packages share one major',
      detail: mismatched.length ? `Different majors: ${majors.map(([name, value]) => `${name}@${value ?? '?'}`).join(', ')}.` : 'All installed @capacitor packages use the same major.',
      fix: mismatched.length ? 'Install the same major for @capacitor/core, cli, ios and android.' : null,
    })
    if (!packages['@capacitor/cli'])
      add({ id: 'capacitor.cli', status: 'fail', severity: 'blocker', title: '@capacitor/cli is installed', detail: '@capacitor/cli is missing, so npx cap commands will not match the project version.', fix: 'Install @capacitor/cli@latest as a dev dependency.' })
    for (const platform of platforms) {
      const name = `@capacitor/${platform}`
      add({
        id: `capacitor.${platform}_package`,
        status: packages[name] ? 'pass' : 'fail',
        severity: 'blocker',
        title: `${name} is installed`,
        detail: packages[name] ? `${name} ${packages[name]}.` : `${name} is missing.`,
        fix: packages[name] ? null : `Install ${name}@latest, then npx cap add ${platform}.`,
      })
    }
  }

  // Node.
  const nodeNeeded = nodeRequirement(Math.max(core?.[0] ?? latestMajor, 8))
  const node = parseVersion(project.nodeVersion)
  const nodeMinimum = Number(nodeNeeded.replace('>=', ''))
  add({
    id: 'tooling.node',
    status: node ? (node[0] >= nodeMinimum ? 'pass' : 'fail') : 'unknown',
    severity: 'blocker',
    title: `Node ${nodeNeeded}`,
    detail: node ? `Node ${project.nodeVersion} is installed; Capacitor needs ${nodeNeeded}.` : `Capacitor needs Node ${nodeNeeded}.`,
    fix: node && node[0] < nodeMinimum ? `Install Node ${nodeMinimum} LTS or newer.` : null,
    how_to_check: 'node --version',
  })

  // Capacitor config.
  if (!config) {
    add({ id: 'config.present', status: 'unknown', severity: 'blocker', title: 'capacitor.config is valid', detail: 'Pass capacitorConfig (appId, appName, webDir, server, ios, android, plugins from capacitor.config.*).', fix: null, how_to_check: 'Read capacitor.config.ts/json, or run npx cap config --json when available.' })
  }
  else {
    const problem = config.appId ? appIdProblem(config.appId) : 'appId is missing.'
    add({ id: 'config.app_id', status: problem ? 'fail' : 'pass', severity: 'blocker', title: 'App ID is a permanent reverse domain', detail: problem ?? `appId ${config.appId}.`, fix: problem ? 'Choose the final reverse-domain app ID with the user and set appId (and the native bundle identifiers) before the first store upload.' : null })
    add({ id: 'config.app_name', status: config.appName ? 'pass' : 'fail', severity: 'required', title: 'App name is set', detail: config.appName ? `appName ${config.appName}.` : 'appName is missing.', fix: config.appName ? null : 'Set appName (the name under the icon).' })
    const expected = detectFramework(packages)
    const expectedDir = expected ? frameworkInfo(expected).webDir : null
    const webDirMatches = !expectedDir || !config.webDir || expectedDir.includes('<') || config.webDir.replace(/^\.\//, '').replace(/\/$/, '') === expectedDir
    add({
      id: 'config.web_dir',
      status: !config.webDir ? 'fail' : webDirMatches ? 'pass' : 'warn',
      severity: 'blocker',
      title: 'webDir points at the static build output',
      detail: !config.webDir ? 'webDir is missing.' : webDirMatches ? `webDir ${config.webDir}.` : `webDir is ${config.webDir} but ${frameworkInfo(expected!).name} usually writes ${expectedDir}.`,
      fix: !config.webDir || !webDirMatches ? `Set webDir to the folder that contains the built index.html${expectedDir ? ` (usually ${expectedDir})` : ''}.` : null,
      checklist_id: 'native.static_build',
    })
    const serverUrl = typeof config.server?.url === 'string' ? config.server.url : undefined
    add({ id: 'config.no_server_url', status: serverUrl ? 'fail' : 'pass', severity: 'blocker', title: 'No remote server.url in the release config', detail: serverUrl ? `server.url is ${serverUrl}: the app loads a remote page instead of its bundle.` : 'The app loads its bundled web assets.', fix: serverUrl ? 'Remove server.url (and server.cleartext) from capacitor.config for release builds.' : null, checklist_id: 'native.bundled_assets' })
    if (config.server?.cleartext === true)
      add({ id: 'config.cleartext', status: 'warn', severity: 'required', title: 'Cleartext HTTP disabled', detail: 'server.cleartext allows plain HTTP traffic, which is meant for live reload only.', fix: 'Remove server.cleartext from the release config.' })
    if (platforms.includes('android') && config.android && 'adjustMarginsForEdgeToEdge' in config.android)
      add({ id: 'config.legacy_edge_to_edge', status: 'fail', severity: 'required', title: 'No removed android.adjustMarginsForEdgeToEdge', detail: 'Capacitor 8 removed android.adjustMarginsForEdgeToEdge; it is ignored and layouts that relied on it overlap the system bars.', fix: 'Delete it and pad with safe-area CSS (SystemBars handles insets).', checklist_id: 'design.android_edge_to_edge' })
    if (platforms.includes('ios') && config.ios?.contentInset === 'always' && project.safeAreaCss)
      add({ id: 'config.double_inset', status: 'warn', severity: 'required', title: 'Safe area applied once', detail: 'ios.contentInset: \'always\' plus safe-area CSS pads the content twice.', fix: 'Remove ios.contentInset (default never) and keep the CSS padding.', checklist_id: 'design.safe_areas' })
  }

  // Build output and native projects.
  add({ id: 'build.index_html', status: flag(project.webDirHasIndexHtml, true), severity: 'blocker', title: 'Build output contains index.html', detail: project.webDirHasIndexHtml === false ? 'The web build folder has no index.html at its root.' : 'Capacitor needs index.html at the root of webDir.', fix: project.webDirHasIndexHtml === false ? 'Switch the framework to static/SPA output and rebuild.' : null, checklist_id: 'native.static_build' })
  add({ id: 'build.no_localhost', status: flag(project.localhostInBuild, false), severity: 'blocker', title: 'No localhost URLs in the build', detail: project.localhostInBuild ? 'The built files call localhost or 127.0.0.1, which is the phone itself inside the app.' : 'API URLs point at reachable hosts.', fix: project.localhostInBuild ? 'Set the production API URL env variable and rebuild.' : null, how_to_check: 'grep -rn "localhost:\\|127.0.0.1" <webDir>' })
  for (const platform of platforms) {
    const present = platform === 'ios' ? project.iosProject : project.androidProject
    add({ id: `native.${platform}_project`, status: flag(present, true), severity: 'blocker', title: `${platform}/ native project exists`, detail: present === false ? `There is no ${platform}/ folder.` : `npx cap add ${platform} creates the ${platform}/ project.`, fix: present === false ? `npx cap add ${platform}, then npx cap sync.` : null, how_to_check: `test -d ${platform}` })
  }

  // Design.
  const viewport = project.viewportMeta
  add({ id: 'design.viewport_fit_cover', status: viewport === undefined ? 'unknown' : viewport.includes('viewport-fit=cover') ? 'pass' : 'fail', severity: 'blocker', title: 'Viewport uses viewport-fit=cover', detail: viewport === undefined ? 'Pass project.viewportMeta (the content of <meta name="viewport">).' : `viewport is "${viewport.slice(0, 200)}".`, fix: viewport !== undefined && !viewport.includes('viewport-fit=cover') ? 'Use content="width=device-width, initial-scale=1, viewport-fit=cover".' : null, checklist_id: 'design.viewport_fit_cover' })
  const uiKit = handlesSafeAreas(packages)
  add({
    id: 'design.safe_areas',
    status: uiKit ? 'pass' : flag(project.safeAreaCss, true),
    severity: 'required',
    title: 'Safe areas are padded',
    detail: uiKit ? `${uiKit} applies safe-area insets; do not add a second padding.` : project.safeAreaCss === false ? 'No safe-area-inset CSS found: headers and tab bars will sit under the notch and home indicator.' : 'The app shell pads env(safe-area-inset-*) / --safe-area-inset-*.',
    fix: !uiKit && project.safeAreaCss === false ? 'Pad the app shell with var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) and the other sides.' : null,
    checklist_id: 'design.safe_areas',
  })
  add({ id: 'design.no_install_prompt', status: flag(project.installPrompt, false), severity: 'required', title: 'No PWA install prompt in the app', detail: project.installPrompt ? 'The app still shows a web install or download-the-app prompt.' : 'No beforeinstallprompt UI inside the app.', fix: project.installPrompt ? 'Hide install prompts and store banners when Capacitor.isNativePlatform().' : null, checklist_id: 'design.no_web_chrome' })
  if (platforms.includes('android'))
    add({ id: 'design.android_back_button', status: flag(project.androidBackButton, true), severity: 'required', title: 'Android back button handled', detail: project.androidBackButton === false ? 'No backButton listener: Android back exits the app from any screen.' : 'App.addListener(\'backButton\') navigates back.', fix: project.androidBackButton === false ? 'Add App.addListener(\'backButton\', ({ canGoBack }) => canGoBack ? history.back() : App.exitApp()).' : null, checklist_id: 'design.app_navigation' })
  add({ id: 'design.external_links', status: project.externalLinksInBrowser === false ? 'warn' : flag(project.externalLinksInBrowser, true), severity: 'required', title: 'External links open outside the WebView', detail: project.externalLinksInBrowser === false ? 'External links open inside the app WebView and replace the app.' : 'External links use the system browser or @capacitor/browser.', fix: project.externalLinksInBrowser === false ? 'Open them with Browser.open({ url }).' : null, checklist_id: 'design.external_links' })
  add({ id: 'design.offline_state', status: project.offlineState === false ? 'warn' : flag(project.offlineState, true), severity: 'required', title: 'Offline state', detail: project.offlineState === false ? 'Without network the app shows a blank page or browser error.' : 'The app renders an offline state.', fix: project.offlineState === false ? 'Detect @capacitor/network status and render an offline/retry screen.' : null, checklist_id: 'design.offline_and_errors' })
  add({ id: 'design.app_icon', status: flag(project.customAppIcon, true), severity: 'required', title: 'Custom app icon', detail: project.customAppIcon === false ? 'The native projects still use the default Capacitor icon.' : 'The app ships its own icon.', fix: project.customAppIcon === false ? 'Add assets/icon-only.png (1024x1024) and run npx @capacitor/assets generate.' : null, checklist_id: 'design.icon_and_splash' })
  add({ id: 'design.splash_screen', status: project.splashScreen === false ? 'warn' : flag(project.splashScreen, true), severity: 'recommended', title: 'Branded splash screen', detail: project.splashScreen === false ? 'The splash screen is the default one.' : 'The splash screen matches the first screen.', fix: project.splashScreen === false ? 'Add assets/splash.png and splash-dark.png and run npx @capacitor/assets generate.' : null, how_to_check: 'Compare ios/App/App/Assets.xcassets/Splash.imageset and android/app/src/main/res/drawable*/splash.png with the Capacitor template images.', checklist_id: 'design.icon_and_splash' })
  add({ id: 'native.service_worker', status: project.serviceWorker === undefined ? 'unknown' : project.serviceWorker ? 'warn' : 'pass', severity: 'required', title: 'No service worker in the app build', detail: project.serviceWorker ? 'A service worker registers inside the app and can serve stale bundles.' : 'No service worker registration in the app build.', fix: project.serviceWorker ? 'Skip registration when Capacitor.isNativePlatform().' : null, checklist_id: 'native.service_worker' })

  // Native permissions and platform requirements.
  const features = app.features ?? []
  if (platforms.includes('ios')) {
    // "A or B" entries are satisfied by either key.
    const neededKeys = [...new Set(features.flatMap(feature => PLUGINS[feature]?.flatMap(spec => spec.iosUsageKeys ?? []) ?? []))]
    if (!neededKeys.length) {
      add({ id: 'ios.usage_strings', status: features.length ? 'pass' : 'not_applicable', severity: 'blocker', title: 'iOS purpose strings for every permission', detail: features.length ? 'The listed features need no iOS purpose string.' : 'No native features listed in app.features.', fix: null, checklist_id: 'native.permission_strings' })
    }
    else if (!project.iosUsageKeys) {
      add({ id: 'ios.usage_strings', status: 'unknown', severity: 'blocker', title: 'iOS purpose strings for every permission', detail: `The listed features need ${neededKeys.join(', ')}.`, fix: null, how_to_check: 'List the NS*UsageDescription keys in ios/App/App/Info.plist and pass them as project.iosUsageKeys.', checklist_id: 'native.permission_strings' })
    }
    else {
      const present = new Set(project.iosUsageKeys)
      const missing = neededKeys.filter(key => !key.split(' or ').some(option => present.has(option)))
      add({ id: 'ios.usage_strings', status: missing.length ? 'fail' : 'pass', severity: 'blocker', title: 'iOS purpose strings for every permission', detail: missing.length ? `Missing in Info.plist: ${missing.join(', ')}. The app crashes when it first requests that access.` : 'Every needed purpose string is in Info.plist.', fix: missing.length ? 'Add each key with a specific sentence explaining why the app needs the access.' : null, checklist_id: 'native.permission_strings' })
    }
    add({ id: 'ios.privacy_manifest', status: flag(project.iosPrivacyManifest, true), severity: 'required', title: 'PrivacyInfo.xcprivacy in the app target', detail: project.iosPrivacyManifest === false ? 'No privacy manifest: uploads get ITMS-91053 warnings and review can reject the app.' : 'The app target has a privacy manifest.', fix: project.iosPrivacyManifest === false ? 'Add PrivacyInfo.xcprivacy with the required-reason APIs the app and manifest-less plugins use.' : null, checklist_id: 'apple.privacy' })
    if (core && (core[0] > 8 || (core[0] === 8 && core[1] >= 5)))
      add({ id: 'ios.scene_lifecycle', status: project.iosSceneDelegate === false ? 'warn' : flag(project.iosSceneDelegate, true), severity: 'required', title: 'UIScene lifecycle adopted', detail: project.iosSceneDelegate === false ? 'No SceneDelegate.swift: Xcode 27 builds (required from April 2027) need the scene lifecycle.' : 'The iOS project uses the scene lifecycle.', fix: project.iosSceneDelegate === false ? 'Apply the Capacitor 8.5 UIScene changes (SceneDelegate.swift, UIApplicationSceneManifest).' : null, checklist_id: 'apple.sdk_requirement' })
  }
  if (platforms.includes('android')) {
    const target = project.androidTargetSdk
    add({ id: 'android.target_sdk', status: target === undefined ? 'unknown' : target >= 36 ? 'pass' : 'fail', severity: 'blocker', title: 'Android targetSdkVersion 36', detail: target === undefined ? 'Pass project.androidTargetSdk from android/variables.gradle.' : `targetSdkVersion is ${target}.`, fix: target !== undefined && target < 36 ? 'Set targetSdkVersion and compileSdkVersion to 36 (upgrade Capacitor if needed).' : null, checklist_id: 'google.target_api' })
  }

  // Live updates.
  const updater = packages?.['@capgo/capacitor-updater']
  add({ id: 'capgo.live_updates', status: !packages ? 'unknown' : updater ? 'pass' : 'warn', severity: 'recommended', title: 'Capgo live updates installed', detail: updater ? `@capgo/capacitor-updater ${updater}.` : 'Without the updater in the first store build, every web fix needs a store release.', fix: packages && !updater ? 'The user runs npx @capgo/cli@latest init, or install @capgo/capacitor-updater and call notifyAppReady().' : null, checklist_id: 'native.live_updates' })
  if (updater)
    add({ id: 'capgo.notify_app_ready', status: flag(project.notifyAppReady, true), severity: 'required', title: 'notifyAppReady() called at startup', detail: project.notifyAppReady === false ? 'Without notifyAppReady() every live update is rolled back after the timeout.' : 'CapacitorUpdater.notifyAppReady() runs on startup.', fix: project.notifyAppReady === false ? 'Call CapacitorUpdater.notifyAppReady() at the top of the entry file.' : null, how_to_check: 'grep -rn "notifyAppReady" src', checklist_id: 'native.live_updates' })

  // Store policy.
  const nativeFeatureCount = features.filter(feature => feature !== 'live_updates').length
  add({ id: 'store.native_value', status: app.features === undefined ? 'unknown' : nativeFeatureCount >= 2 ? 'pass' : 'warn', severity: 'required', title: 'Native value beyond the website', detail: app.features === undefined ? 'Pass app.features with the native features the app actually uses.' : `${nativeFeatureCount} native feature(s) listed.`, fix: app.features !== undefined && nativeFeatureCount < 2 ? 'Add native capabilities that serve the core use case (push, offline, camera, biometrics, share, native navigation) before submitting to Apple.' : null, how_to_check: 'List the features that exist only in the app.', checklist_id: platforms.includes('ios') ? 'apple.minimum_functionality' : undefined })
  if (traits.has('accounts'))
    add({ id: 'store.account_deletion', status: flag(app.accountDeletion, true), severity: 'blocker', title: 'In-app account deletion', detail: app.accountDeletion === false ? 'Users can create accounts but cannot delete them from the app.' : 'Apple 5.1.1(v) and Google Play need in-app deletion when accounts exist.', fix: app.accountDeletion === false ? 'Add a Delete account action (and a web deletion link for Google Play).' : null, checklist_id: platforms.includes('ios') ? 'apple.account_deletion' : 'google.account_deletion' })
  if (traits.has('accounts'))
    add({ id: 'store.demo_account', status: flag(app.demoAccount, true), severity: 'required', title: 'Demo account for reviewers', detail: app.demoAccount === false ? 'Reviewers cannot get past the login screen.' : 'App Review and Play app access need working demo credentials.', fix: app.demoAccount === false ? 'Create a reviewer account and add it to App Store Connect and Play Console.' : null, checklist_id: platforms.includes('ios') ? 'apple.demo_account' : 'google.data_safety' })
  if (traits.has('third_party_login') && platforms.includes('ios'))
    add({ id: 'store.sign_in_with_apple', status: flag(app.signInWithApple, true), severity: 'blocker', title: 'Sign in with Apple offered', detail: app.signInWithApple === false ? 'Third-party login on iOS without Sign in with Apple or an equivalent option is rejected under 4.8.' : 'Apple 4.8 needs an equivalent privacy-preserving login.', fix: app.signInWithApple === false ? 'Add Sign in with Apple with @capgo/capacitor-social-login.' : null, checklist_id: 'apple.login_services' })
  if (traits.has('digital_goods'))
    add({ id: 'store.store_billing', status: flag(app.nativeIap, true), severity: 'blocker', title: 'Digital goods use store billing', detail: app.nativeIap === false ? 'Digital goods are sold through web checkout inside the app.' : 'Apple 3.1.1 and Google Play Billing apply to digital goods.', fix: app.nativeIap === false ? 'Use @capgo/native-purchases or remove digital checkout from the store builds.' : null, checklist_id: platforms.includes('ios') ? 'apple.in_app_purchase' : 'google.play_billing' })

  const blocking = checks.filter(check => check.status === 'fail' && check.severity !== 'recommended')
  const unknownBlockers = checks.filter(check => check.status === 'unknown' && check.severity === 'blocker')
  const summary = { pass: 0, fail: 0, warn: 0, unknown: 0, not_applicable: 0 }
  for (const check of checks)
    summary[check.status] += 1
  const ready = blocking.length === 0 && unknownBlockers.length === 0
  return {
    ready,
    verdict: ready
      ? 'No blocking problems found in the reported facts. Run the app on devices and go through capgo_get_mobile_checklist (apple_review, google_play) before submitting.'
      : blocking.length
        ? `${blocking.length} blocking problem(s): fix them, then call this tool again with the updated facts.`
        : `${unknownBlockers.length} blocker check(s) need facts: inspect the project and call this tool again.`,
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
      requirements: ['A successful Capgo iOS build of this app (signing credentials saved with npx @capgo/cli@latest build init).'],
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

  const identity = suggestAppId({ appId: input.appId, websiteUrl: input.websiteUrl, appName: input.appName })
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
  const buildRun = framework.buildCommand ? runScript(pm, 'build') : null
  const syncCommand = buildRun ? `${buildRun} && npx cap sync` : 'npx cap sync'
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
    const staticSteps: PlanStep[] = [
      step({
        id: 'static_output',
        title: framework.staticByDefault ? `Confirm the ${framework.name} static output` : `Switch ${framework.name} to a static build`,
        detail: framework.steps.join(' '),
        commands: shell && buildRun ? [buildRun, `test -f ${webDir}/index.html && echo "index.html OK"`] : [],
        verify: [`${webDir}/index.html exists after the build.`, 'No page depends on SSR, API routes or server actions at runtime.'],
        skill: 'framework-to-capacitor',
        checklist_ids: ['native.static_build'],
      }),
    ]
    if (framework.serverFeatures.length) {
      staticSteps.push(step({
        id: 'move_server_code',
        title: 'Move server-only code to a hosted API',
        detail: `Look for: ${framework.serverFeatures.join(', ')}. List them for the user and agree where each moves (existing backend, serverless function or native plugin) before deleting anything. The app calls the API over HTTPS from capacitor://localhost (iOS) and https://localhost (Android).`,
        checklist_ids: ['native.api_origins', 'native.auth_redirects'],
        skill: 'framework-to-capacitor',
      }))
    }
    staticSteps.push(step({
      id: 'mobile_build_script',
      title: 'Add one script that builds and syncs',
      detail: 'A single script avoids syncing stale assets.',
      files: [{ path: 'package.json', change: `"scripts": { "build:mobile": "${framework.buildCommand ? `${framework.buildCommand} && ` : ''}cap sync" }` }],
    }))
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
  if (!existing.capacitorConfig) {
    capacitorSteps.push(step({
      id: 'cap_init',
      title: 'Create capacitor.config.ts',
      detail: `Sets the app name, app ID and webDir. Run it only after the user confirmed the app ID. ${framework.id === 'angular' ? 'Replace <project> with the angular.json project name.' : ''}`.trim(),
      commands: [`npx cap init "${appName.replaceAll('"', '')}" ${identity.app_id} --web-dir ${webDir}`],
      files: [{ path: 'capacitor.config.ts', change: `import type { CapacitorConfig } from '@capacitor/cli'\n\nconst config: CapacitorConfig = {\n  appId: '${identity.app_id}',\n  appName: '${appName.replaceAll('\'', '')}',\n  webDir: '${webDir}',\n}\n\nexport default config` }],
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
        commands: featurePlugins.install_command ? [featurePlugins.install_command, 'npx cap sync', 'npx cap ls'] : ['npx cap sync', 'npx cap ls'],
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
        detail: 'Pick the first available run option from run_options. Inspect the WebView with Safari Web Inspector (iOS) or chrome://inspect (Android) for console errors, CORS failures and 404s.',
        commands: platforms.map(platform => `npx cap run ${platform} --list`),
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
        detail: 'Recommended: the user runs npx @capgo/cli@latest init in the app folder (interactive: installs the updater, adds notifyAppReady, creates the channel and uploads the first bundle). Manual alternative below. Live updates change web assets only.',
        commands: [addCommand(pm, ['@capgo/capacitor-updater@latest']), 'npx cap sync'],
        files: [
          { path: 'entry file (main.ts / main.tsx / app root)', change: 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\'\n\nCapacitorUpdater.notifyAppReady()' },
          { path: 'capacitor.config.ts', change: 'plugins: { CapacitorUpdater: { autoUpdate: \'atBackground\' } }' },
        ],
        verify: ['npx @capgo/cli@latest doctor reports no problem.'],
        skill: 'capgo-live-updates',
        checklist_ids: ['native.live_updates', 'release.live_update_policy'],
      }),
      step({
        id: 'upload_bundle',
        title: 'Upload the first web bundle',
        detail: 'Build, then upload with the command from capgo_get_upload_command, or package with npx @capgo/cli@latest bundle zip <appId> --for-upload --json and use capgo_prepare_bundle_upload, a PUT to the signed URL and capgo_complete_bundle_upload. Enable allow_preview to open it in the Capgo app.',
        commands: buildRun ? [buildRun] : [],
        mcp_tools: ['capgo_get_upload_command', 'capgo_prepare_bundle_upload', 'capgo_complete_bundle_upload', 'capgo_update_app'],
        checklist_ids: ['release.channels'],
      }),
      step({
        id: 'cloud_build',
        title: 'Native builds with Capgo Cloud Build',
        detail: 'The user runs npx @capgo/cli@latest build init once per platform to save signing credentials (never paste secrets into the chat). Then package and build. Builds use build minutes; iOS builds run on the current Xcode.',
        commands: platforms.map(platform => `npx @capgo/cli@latest build zip ${identity.app_id} --platform ${platform} --json`),
        mcp_tools: ['capgo_get_build_credentials', 'capgo_request_build', 'capgo_start_build', 'capgo_get_build_status', 'capgo_get_build_logs'],
        skill: 'capgo-native-builds',
        checklist_ids: ['release.cloud_build', 'apple.sdk_requirement', 'google.app_bundle'],
        run_by: 'user',
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
