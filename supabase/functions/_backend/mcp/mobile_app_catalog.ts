/**
 * Data behind the hosted MCP web app to mobile tools: frameworks, plugins and checklist rules.
 *
 * Distilled from Capgo's public Capacitor skills (https://github.com/Cap-go/capgo-skills). Keep it
 * in sync with those skills; mobile_app.ts holds the logic that reads it. Excluded from Sonar CPD
 * because rows of same-shaped records always look duplicated to it.
 */

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PLATFORMS = ['ios', 'android'] as const

export type Platform = typeof PLATFORMS[number]

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

export interface FrameworkInfo {
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

export const FRAMEWORKS: FrameworkInfo[] = [
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

export interface PluginSpec {
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

export const PLUGINS: Record<MobileFeature, PluginSpec[]> = {
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
    iosUsageKeys: ['NSCalendarsFullAccessUsageDescription', 'NSCalendarsUsageDescription'],
    androidPermissions: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
    notes: ['Reading, changing or deleting events needs full access (NSCalendarsFullAccessUsageDescription). An app that only creates events can ship NSCalendarsWriteOnlyAccessUsageDescription instead. NSCalendarsUsageDescription covers devices before iOS 17.'],
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
export const BASELINE_PLUGINS: PluginSpec[] = [
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

export interface ChecklistSpec {
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
    fix: 'The user runs npx @capgo/cli@latest build init once per platform and stores the credentials on Capgo with npx @capgo/cli@latest build credentials push; then package with build zip and call capgo_request_build and capgo_start_build.',
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
