import { z } from 'zod'
import { CHECK_STATUSES, HOST_OS, PACKAGE_MANAGERS, PLAN_SOURCES } from './mobile_app.ts'
import { APP_TRAITS, CHECKLIST_TOPICS, FRAMEWORK_IDS, MOBILE_FEATURES, NEW_APP_TEMPLATES, PLATFORMS, SEVERITIES } from './mobile_app_catalog.ts'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const MAX_PACKAGES = 3000

// Each tool describes platforms and packages with its own use of them.
const platformsInput = z.array(z.enum(PLATFORMS)).min(1).max(2).optional()
const packagesInput = z.record(z.string().min(1).max(214), z.string().max(256))
  .refine(value => Object.keys(value).length <= MAX_PACKAGES, { message: `At most ${MAX_PACKAGES} packages.` })
  .optional()
const featuresInput = z.array(z.enum(MOBILE_FEATURES)).max(MOBILE_FEATURES.length)
const traitsInput = z.array(z.enum(APP_TRAITS)).max(APP_TRAITS.length).optional()
  .describe('Product traits that turn on store rules: accounts (users sign up or log in), third_party_login (Google/Facebook/...), digital_goods (subscriptions, credits, premium features), physical_goods, user_generated_content, kids, health_data, location, push, ads_or_tracking, ai_features (user data sent to an AI service), personal_play_account (Google Play personal developer account created after 2023-11-13).')
const packageManagerInput = z.enum(PACKAGE_MANAGERS).optional()
  .describe('Package manager of the project, from its lockfile. Commands use it for installs; Capacitor and Capgo commands stay npx. Default npm.')

export const planMobileAppInputSchema = z.object({
  source: z.enum(PLAN_SOURCES).describe('Starting point, which decides the first phases: migrating a web app whose source code you can read, a live website known only by its URL (the plan warns that its source code or a static export is needed), or a new app with no code yet (the plan scaffolds a Vite app).'),
  packages: packagesInput.describe('Installed packages from package.json, with dependencies and devDependencies merged into one name-to-version-range object such as {"next":"^15.2.0","@capacitor/core":"^8.4.0"}. The plan detects the framework and the installed Capacitor version from it, and leaves out installs for packages already listed. Omit when the project has no package.json.'),
  framework: z.enum(FRAMEWORK_IDS).optional().describe('Web framework of the project, which sets the static build command and the folder Capacitor packages. Omit to detect it from packages; set it only when detection is wrong or there is no package.json. A value that differs from the packages wins, with a warning.'),
  template: z.enum(NEW_APP_TEMPLATES).optional().describe('new_app only: Vite template for the scaffold. Default react.'),
  projectName: z.string().trim().min(1).max(64).optional().describe('new_app only: folder name for the new project. Defaults to the app name.'),
  appName: z.string().trim().min(1).max(64).optional().describe('Name shown under the app icon. Ask the user; defaults from the website domain.'),
  appId: z.string().trim().min(3).max(155).optional().describe('Reverse-domain app ID the user owns, e.g. com.acme.shop. It becomes the iOS bundle identifier and Android applicationId and is permanent once published. Omit to get a suggestion.'),
  websiteUrl: z.string().url().max(2048).optional().describe('Public URL of the website, used to suggest the app name and app ID. Required context for source website_only.'),
  platforms: platformsInput.describe('Platforms to publish on. The plan adds only these native projects, run options and store steps. Omit to plan for every supported platform.'),
  features: featuresInput.optional().describe('Native features the app needs, from the user\'s goals and the audit. Each one adds a plugin recommendation; live_updates is always added.'),
  traits: traitsInput,
  packageManager: packageManagerInput,
  environment: z.object({
    shell: z.boolean().optional().describe('true when you can run commands in the user\'s project. false (for example a web chat or app builder without a terminal) switches the plan to a handoff.'),
    os: z.enum(HOST_OS).optional().describe('Operating system of the machine that runs the commands. iOS simulators and local iOS builds need macos.'),
    xcode: z.boolean().optional().describe('Result of xcodebuild -version: true when Xcode is installed.'),
    androidSdk: z.boolean().optional().describe('true when the Android SDK and an emulator image are installed (ANDROID_HOME set, or Android Studio present).'),
    nodeVersion: z.string().trim().min(1).max(32).optional().describe('Output of node --version, e.g. v22.12.0.'),
  }).optional().describe('What the agent can do on this machine. Omit fields you have not checked.'),
  existing: z.object({
    capacitorConfig: z.boolean().optional().describe('capacitor.config.ts or capacitor.config.json already exists.'),
    ios: z.boolean().optional().describe('The ios/ native project already exists.'),
    android: z.boolean().optional().describe('The android/ native project already exists.'),
    capgoApp: z.boolean().optional().describe('The app is already registered in Capgo (capgo_get_app succeeds).'),
  }).optional().describe('Steps already done, so the plan skips them.'),
})

export const recommendPluginsInputSchema = z.object({
  features: featuresInput.min(1).describe('Device capabilities the app needs, from the user\'s goals or what the web app already does in the browser. Each one returns the plugin that provides it, with its permissions and store rules.'),
  platforms: platformsInput.describe('Platforms the app ships on; each pick lists the iOS or Android configuration only for these. Omit to include every supported platform.'),
  packageManager: packageManagerInput,
  packages: packagesInput.describe('Installed packages from package.json, with dependencies and devDependencies merged into one name-to-version-range object. Plugins already listed here are left out of the combined install command. Omit when the project has no package.json.'),
  includeBaseline: z.boolean().optional().describe('Also list the plugins every app needs (@capacitor/app, splash-screen, keyboard). Default true.'),
})

export const mobileChecklistInputSchema = z.object({
  topics: z.array(z.enum(CHECKLIST_TOPICS)).min(1).max(CHECKLIST_TOPICS.length).optional().describe('Checklist sections to return, for example only the store sections right before submission. Omit to return every section.'),
  platforms: platformsInput.describe('Platforms the app will be published on. Rules that apply only to other platforms are left out. Omit to include the rules of every supported platform.'),
  traits: traitsInput.describe('Product traits of the app, such as user accounts, digital goods or user-generated content. Each one adds the store rules that apply to it; rules for traits you do not pass are listed in skipped_conditional. personal_play_account means a personal Google Play developer account created after 2023-11-13, which must run a closed test before production. Omit when none apply.'),
  includeAllConditional: z.boolean().optional().describe('List rules for every trait, not only the traits passed. Default false.'),
})

export const mobileReadinessInputSchema = z.object({
  platforms: platformsInput.describe('Platforms the app will ship on. Platform-specific checks, such as the iOS app ID rules, iOS purpose strings or the Android target SDK, run only for these. Omit to check every supported platform.'),
  packages: packagesInput.describe('Installed packages from package.json, with dependencies and devDependencies merged into one name-to-version-range object. Used to compare the installed Capacitor with the latest release, check that the @capacitor packages share one major, find the folder the framework builds to, and detect safe-area UI kits and the Capgo live updates plugin. Omit when there is no package.json; those checks are then reported as unknown.'),
  capacitorConfig: z.object({
    appId: z.string().max(155).optional().describe('Reverse-domain app ID set in capacitor.config; it becomes the iOS bundle identifier and the Android applicationId. Checked as a valid, final reverse domain, including the iOS rules when iOS ships; a missing value fails the check.'),
    appName: z.string().max(255).optional().describe('App name set in capacitor.config, shown under the app icon. A missing value fails the app name check.'),
    webDir: z.string().max(512).optional().describe('Build output folder set in capacitor.config, which Capacitor copies into the native projects. Compared with the folder the detected framework writes; a missing value blocks release.'),
    server: z.record(z.string(), z.unknown()).optional().describe('server object from capacitor.config, meant for live reload during development. A url there makes the app load a remote page instead of its bundled files and blocks release; cleartext set to true is reported as a warning. Omit when the config has no server object.'),
    ios: z.record(z.string(), z.unknown()).optional().describe('ios object from capacitor.config. contentInset set to always is flagged when the CSS already pads the safe areas, because the content is then padded twice. Omit when the config has no ios object.'),
    android: z.record(z.string(), z.unknown()).optional().describe('android object from capacitor.config. The adjustMarginsForEdgeToEdge option is flagged because Capacitor 8 removed it and ignores it. Omit when the config has no android object.'),
  }).optional().describe('Values read from capacitor.config.ts or capacitor.config.json. Omit when the file does not exist yet.'),
  project: z.object({
    webDirHasIndexHtml: z.boolean().optional().describe('Whether the production build wrote index.html at the root of webDir. Capacitor opens that file at launch, so false blocks release. Omit until you have run the build.'),
    iosProject: z.boolean().optional().describe('The ios/ folder exists.'),
    androidProject: z.boolean().optional().describe('The android/ folder exists.'),
    viewportMeta: z.string().max(500).optional().describe('content attribute of <meta name="viewport"> in the app\'s index.html.'),
    safeAreaCss: z.boolean().optional().describe('The styles pad the app shell with env(safe-area-inset-*) or --safe-area-inset-* (grep -rn "safe-area-inset" src).'),
    serviceWorker: z.boolean().optional().describe('The app build registers a service worker.'),
    installPrompt: z.boolean().optional().describe('The app shows a PWA install prompt (beforeinstallprompt) or a download-the-app banner.'),
    androidBackButton: z.boolean().optional().describe('The app handles App.addListener(\'backButton\').'),
    externalLinksInBrowser: z.boolean().optional().describe('External links open with @capacitor/browser or the system browser.'),
    offlineState: z.boolean().optional().describe('The app renders an offline or retry screen without network.'),
    localhostInBuild: z.boolean().optional().describe('The built files reference localhost or 127.0.0.1 (grep the webDir).'),
    iosUsageKeys: z.array(z.string().max(128)).max(100).optional().describe('NS...UsageDescription keys present in ios/App/App/Info.plist.'),
    iosPrivacyManifest: z.boolean().optional().describe('ios/App/App/PrivacyInfo.xcprivacy exists in the app target.'),
    iosSceneDelegate: z.boolean().optional().describe('ios/App/App/SceneDelegate.swift exists (UIScene lifecycle).'),
    androidTargetSdk: z.number().int().min(1).max(100).optional().describe('targetSdkVersion from android/variables.gradle.'),
    customAppIcon: z.boolean().optional().describe('The native projects use the app\'s own icon, not the default Capacitor icon.'),
    splashScreen: z.boolean().optional().describe('The splash screen is branded, not the default.'),
    notifyAppReady: z.boolean().optional().describe('The entry file calls CapacitorUpdater.notifyAppReady().'),
    nodeVersion: z.string().max(32).optional().describe('Output of node --version.'),
  }).optional().describe('Facts you inspected in the project. Omit anything you did not check; it is reported as unknown with how to check it.'),
  app: z.object({
    features: featuresInput.optional().describe('Native features the app actually uses. Used for iOS purpose strings and the Apple 4.2 native value check.'),
    traits: traitsInput,
    accountDeletion: z.boolean().optional().describe('Users can delete their account from inside the app.'),
    signInWithApple: z.boolean().optional().describe('Sign in with Apple (or an equivalent privacy-preserving login) is offered on iOS.'),
    nativeIap: z.boolean().optional().describe('Digital goods are sold through Apple In-App Purchase and Google Play Billing.'),
    demoAccount: z.boolean().optional().describe('A demo account for store reviewers exists.'),
  }).optional().describe('Product facts that store review checks.'),
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const text = (description: string) => z.string().describe(description)
const strings = (description: string) => z.array(z.string()).describe(description)
const platformList = z.array(z.enum(PLATFORMS)).describe('Platforms this entry applies to.')
const skillName = z.string().nullable().describe('Capgo skill with the full procedure (install with npx skills add Cap-go/capgo-skills), or null.')

const skillReference = z.object({
  name: text('Skill name in Cap-go/capgo-skills.'),
  url: text('GitHub folder of the skill; its SKILL.md has the full procedure.'),
  use_for: text('When to load this skill.'),
})

const pluginRecommendation = z.object({
  feature: z.string().describe('Feature this plugin serves, or baseline for plugins every app needs.'),
  package: text('Exact npm package name.'),
  publisher: z.enum(['capacitor', 'capgo']).describe('capacitor: official @capacitor plugin. capgo: Capgo-maintained @capgo plugin.'),
  purpose: text('What the plugin does for this app.'),
  install: text('Install command for the project\'s package manager. Run npx cap sync afterwards.'),
  docs_url: text('Plugin documentation.'),
  ios: z.object({
    usage_keys: strings('Info.plist NS...UsageDescription keys the plugin can trigger; "A or B" means either key.'),
    capabilities: strings('Xcode Signing & Capabilities entries to enable.'),
  }).describe('iOS configuration the plugin needs.'),
  android: z.object({
    permissions: strings('AndroidManifest.xml permissions and runtime prompts to expect.'),
  }).describe('Android configuration the plugin needs.'),
  notes: strings('Setup notes and traps.'),
  store_notes: strings('Store review rules that apply when using this plugin.'),
  checklist_ids: strings('Related ids from capgo_get_mobile_checklist.'),
  skill: skillName,
  alternatives: strings('Other packages for the same capability.'),
})

const checklistItem = z.object({
  id: text('Stable rule id, e.g. design.safe_areas.'),
  topic: z.enum(CHECKLIST_TOPICS).describe('Checklist section.'),
  severity: z.enum(SEVERITIES).describe('blocker: the app fails to build, crashes or is rejected. required: expected by review or users. recommended: quality.'),
  platforms: platformList,
  title: text('Short rule name.'),
  rule: text('What must be true and why.'),
  how_to_check: strings('Commands or manual checks that prove the rule holds.'),
  fix: text('How to fix a violation.'),
  skill: skillName,
  docs_url: z.string().nullable().describe('Official policy or documentation page, or null.'),
})

const planStep = z.object({
  id: text('Stable step id within the phase.'),
  title: text('What this step achieves.'),
  detail: text('Instructions and context for the step.'),
  commands: strings('Shell commands to run in order from the project folder. Empty when the step is a code change or a decision.'),
  files: z.array(z.object({
    path: text('File to create or edit.'),
    change: text('Content to add or the change to make.'),
  })).describe('File changes for this step.'),
  verify: strings('How to confirm the step worked before moving on.'),
  mcp_tools: strings('Capgo MCP tools to call in this step.'),
  skill: skillName,
  checklist_ids: strings('Checklist rules this step satisfies.'),
  run_by: z.enum(['agent', 'user']).describe('agent: run it yourself. user: needs the user (a decision, an interactive command, store accounts or signing secrets).'),
})

const runOption = z.object({
  id: z.enum(['ios_simulator', 'android_emulator', 'physical_device', 'capgo_preview_app', 'capgo_cloud_simulator']).describe('Run target.'),
  title: text('Run target name.'),
  platforms: platformList,
  available: z.enum(['yes', 'no', 'unknown']).describe('Whether it works with the reported environment; unknown when not checked.'),
  requirements: strings('What it needs.'),
  steps: strings('How to start the app on it.'),
  mcp_tools: strings('Capgo MCP tools involved.'),
  cost: text('Cost or quota used.'),
})

export const planMobileAppOutputSchema = z.object({
  summary: text('One-line summary of the plan.'),
  mode: z.enum(['run_commands', 'handoff']).describe('run_commands: execute the agent steps. handoff: you cannot run commands here; write the changes and a handoff document for the user or CI.'),
  source: z.enum(PLAN_SOURCES).describe('Starting point of the plan.'),
  framework: z.object({
    id: z.enum(FRAMEWORK_IDS).describe('Framework the plan targets.'),
    name: text('Framework display name.'),
    detected_from: z.enum(['packages', 'input', 'template', 'none']).describe('How the framework was chosen.'),
    web_dir: text('Static build output folder to use as webDir (replace <project> placeholders).'),
    build_command: z.string().nullable().describe('Command that builds the web assets, or null when there is no build step.'),
    static_export_required: z.boolean().describe('The framework needs configuration changes before it emits a static index.html.'),
    server_features_to_check: strings('Server-only features to search for and move to a hosted API.'),
  }).describe('Web framework and its static build settings.'),
  capacitor: z.object({
    latest_version: text('Latest stable @capacitor/core on npm.'),
    next_version: z.string().nullable().describe('Pre-release on the npm next tag; do not use it for production.'),
    version_source: z.enum(['npm', 'fallback']).describe('npm: read live from the registry. fallback: last known version because npm did not answer.'),
    installed_version: z.string().nullable().describe('@capacitor/core range from packages, or null.'),
    action: z.enum(['install', 'upgrade', 'keep']).describe('What to do with Capacitor in this project.'),
    node_requirement: text('Node.js version range Capacitor needs.'),
  }).describe('Capacitor version decision.'),
  app: z.object({
    name: text('App name to use with npx cap init.'),
    app_id: text('App ID to use with npx cap init; confirm with the user first.'),
    app_id_source: z.enum(['input', 'website', 'placeholder']).describe('input: given by the caller. website: derived from websiteUrl. placeholder: must be replaced by the user\'s own reverse domain.'),
  }).describe('App identity.'),
  platforms: platformList,
  warnings: strings('Risks, blockers and assumptions to tell the user about before starting.'),
  phases: z.array(z.object({
    id: text('Phase id: prepare, scaffold or static_build, capacitor, native_ux, native_features, run, capgo, store.'),
    title: text('Phase name.'),
    goal: text('What is true when the phase is done.'),
    steps: z.array(planStep).describe('Ordered steps.'),
  })).describe('Ordered phases; finish each phase\'s verify checks before the next.'),
  plugins: z.array(pluginRecommendation).describe('Plugin recommendations for the requested features, live updates and the baseline.'),
  run_options: z.array(runOption).describe('Ways to run the app, local and Capgo cloud.'),
  checklist: z.array(z.object({
    id: text('Checklist rule id; read the full rule with capgo_get_mobile_checklist.'),
    severity: z.enum(SEVERITIES).describe('Rule severity.'),
    title: text('Short rule name.'),
  })).describe('Design and native rules to apply while building. Store rules come from capgo_get_mobile_checklist.'),
  skills: z.object({
    install_command: text('Command that installs every Capgo skill into the agent.'),
    items: z.array(skillReference).describe('Skills used by this plan.'),
  }).describe('Capgo skills with the detailed procedures.'),
  next_tool: z.object({
    name: text('Capgo MCP tool to call next.'),
    reason: text('Why to call it now.'),
  }).describe('Suggested next tool call.'),
})

export const recommendPluginsOutputSchema = z.object({
  plugins: z.array(pluginRecommendation).describe('One entry per matching package.'),
  install_command: z.string().nullable().describe('One command installing every package not already in packages, or null when all are installed.'),
  sync_command: text('Command to run after installing plugins.'),
  ios_usage_keys: strings('All Info.plist purpose-string keys these plugins can trigger.'),
  notes: strings('Rules for installing and requesting permissions.'),
})

export const mobileChecklistOutputSchema = z.object({
  items: z.array(checklistItem).describe('Checklist rules for the requested topics, platforms and traits, in working order.'),
  counts: z.object({
    blocker: z.number().int().describe('Number of blocker rules.'),
    required: z.number().int().describe('Number of required rules.'),
    recommended: z.number().int().describe('Number of recommended rules.'),
  }).describe('Rule counts by severity.'),
  skipped_conditional: z.array(z.object({
    id: text('Rule id left out.'),
    applies_when: strings('Traits that turn the rule on.'),
  })).describe('Rules left out because none of their traits was passed; pass the trait to include them.'),
  skills: z.object({
    install_command: text('Command that installs every Capgo skill into the agent.'),
    items: z.array(skillReference).describe('Skills referenced by the listed rules.'),
  }).describe('Capgo skills with the detailed procedures.'),
})

export const mobileReadinessOutputSchema = z.object({
  ready: z.boolean().describe('true when no blocker or required check fails and no blocker check is unknown.'),
  verdict: text('What to do next.'),
  summary: z.object({
    pass: z.number().int().describe('Checks that passed.'),
    fail: z.number().int().describe('Checks that failed.'),
    warn: z.number().int().describe('Checks with a warning.'),
    unknown: z.number().int().describe('Checks without enough facts.'),
    not_applicable: z.number().int().describe('Checks that do not apply.'),
  }).describe('Check counts by status.'),
  blocking: strings('Ids of failing blocker and required checks.'),
  to_inspect: z.array(z.object({
    id: text('Check id.'),
    how_to_check: z.string().nullable().describe('Command or file to inspect.'),
  })).describe('Blocker checks that need facts before the app can be called ready.'),
  checks: z.array(z.object({
    id: text('Check id.'),
    status: z.enum(CHECK_STATUSES).describe('Check result.'),
    severity: z.enum(SEVERITIES).describe('Impact when the check fails.'),
    title: text('What is checked.'),
    detail: text('What was found.'),
    fix: z.string().nullable().describe('How to fix a failure or warning, or null.'),
    how_to_check: z.string().nullable().describe('For unknown checks: what to inspect and pass next time.'),
    checklist_id: z.string().nullable().describe('Related capgo_get_mobile_checklist rule, or null.'),
    skill: skillName,
  })).describe('Every check with its result.'),
  capacitor: z.object({
    latest_version: text('Latest stable @capacitor/core used for the version checks.'),
    version_source: z.enum(['npm', 'fallback']).describe('npm: read live from the registry. fallback: last known version.'),
  }).describe('Capacitor release used for the checks.'),
})
