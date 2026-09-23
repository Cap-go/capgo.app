// Step + progress model for the Appflow migration flow.
import type { AppflowToken } from './auth'
import type { TailStep } from '../tail/flow.js'
import type { BuildScriptChoice, PackageManager } from '../workflow-generator.js'
import type { CiSecretTarget } from '../ci-secrets.js'

// The migration's own interactive steps, plus the shared tail steps
// (build + CI/CD) the flow REUSES inline after `handoff-build` → 'build'.
export type AppflowOwnStep =
  | 'explain' // step 1: secure-auth explanation + support note
  | 'authenticating' // step 2: PKCE login (auto)
  | 'fetch-orgs' // step 3 (auto): list orgs, auto-select if one, else prompt
  | 'select-org' // step 3 (2+ orgs)
  | 'fetch-apps' // step 4 (auto): list apps, auto-select if one, else prompt
  | 'select-app' // step 4 (2+ apps)
  | 'fetch-signing' // step 5: list + download signing (auto)
  | 'select-ios-cert' // step 5 prompt (2+ iOS certs)
  | 'select-android-cert' // step 5 prompt (2+ android certs)
  | 'no-signing-submenu' // step 5 recovery submenu (per-platform or whole-migration)
  | 'fetch-distribution' // step 6: list + download distribution (auto)
  | 'select-ios-dist' // step 6 prompt (2+ iOS distribution credentials)
  | 'select-android-dist' // step 6 prompt (2+ android distribution credentials)
  | 'ios-dist-gapfill' // step 6: no iOS dist -> offer p8 generate/provide
  | 'android-dist-gapfill' // step 6: no Android dist -> offer SA generate/provide
  | 'p8-source-select' // step 8: convert chosen -> generate guided, or provide an existing .p8
  | 'input-p8-path' // step 8 provide: collect the .p8 file path (auto-extract key id from filename)
  | 'input-p8-key-id' // step 8 provide: collect the ASC Key ID (only if not auto-extracted)
  | 'input-p8-issuer-id' // step 8 provide: collect the ASC Issuer ID
  | 'load-provided-p8' // step 8 provide (auto): read+base64 the .p8, merge APPLE_KEY_* into ios
  | 'ios-p8-generate' // step 6/8 (auto): drive the shared asc-key .p8 generate/provide, capture APPLE_KEY_* into ios
  | 'android-sa-generate' // step 6 (auto): drive the shared Google Play service-account flow, capture PLAY_CONFIG_JSON into android
  | 'validate' // step 7 (auto): run advisory checks, then show results
  | 'validate-results' // step 7 (info): surface the advisory results, never block
  | 'p8-upgrade-prompt' // step 8 (iOS only)
  | 'handoff-build' // converge: hand to the build/tail steps
  | 'done'
  | 'error'

// The full step union the appflow driver renders: its own steps + the shared
// tail steps (saving-credentials … build-complete), echoed verbatim — same
// pattern the iOS engine uses to widen OnboardingStep with the tail ids.
export type AppflowStep = AppflowOwnStep | TailStep

export type MigrationScope = 'ios' | 'android'
export type NoSigningScope = 'ios' | 'android'

export interface AppflowProgress {
  scope: MigrationScope // intent: which platform the user chose to migrate
  token?: AppflowToken
  // The Appflow account email (from the cached/issued id_token's `email` claim),
  // surfaced so the user can SEE which Appflow account is being migrated — even
  // when a cached token is reused and the browser never opens.
  appflowAccount?: string
  orgSlug?: string
  appId?: string // the SELECTED Appflow app id (hex), used for the Appflow API only
  capgoAppId?: string // the Capgo app id (Capacitor config appId), used for the build + credential store
  appSlug?: string
  ios?: Record<string, string> // mapped Capgo iOS creds collected so far
  android?: Record<string, string> // mapped Capgo Android creds collected so far
  migratable: { ios: boolean, android: boolean }
  noSigningScope?: NoSigningScope
  // step-5 signing-certificate selection (2+ certs): the chosen Appflow profile
  // `tag` the user picked. Stored so fetch-signing can download THAT cert on
  // re-entry instead of re-prompting (no livelock). Undefined = not yet chosen.
  iosCertTag?: string
  androidCertTag?: string
  // step-6 distribution-credential selection (2+ creds): the chosen Appflow
  // distribution credential id the user picked. Same anti-livelock contract.
  iosDistId?: string
  androidDistId?: string
  // step-6 gap-fill decisions (distribution / upload destination) per platform.
  // 'generate' = the user opted to set up an upload destination via the existing
  // p8 / service-account flow; 'skip' = finish without it. Undefined = not asked.
  iosDistGapfill?: 'generate' | 'skip'
  androidDistGapfill?: 'generate' | 'skip'
  // step-8 iOS app-specific-password -> .p8 API key upgrade decision.
  p8Upgrade?: 'convert' | 'skip'
  // step-8 .p8 source after 'convert': 'generate' drives the guided helper,
  // 'provide' collects an existing .p8 (path -> key id -> issuer id -> load).
  p8Source?: 'generate' | 'provide'
  // step-8 provide chain: the .p8 file path, the ASC Key ID (auto-extracted
  // from an AuthKey_<id>.p8 filename when possible), and the ASC Issuer ID.
  p8Path?: string
  p8KeyId?: string
  p8IssuerId?: string
  // Advisory notes accumulated by auto effects (e.g. a p8/SA generate that could
  // not complete here). Surfaced in validate-results so the feedback isn't lost
  // when the next auto effect overwrites the transient ctx.
  notes?: string[]
  completedSteps: AppflowStep[]

  // ── build hand-off + inline tail state ──────────────────────────────────────
  // handoff-build choice ('build' routes into the shared tail; 'skip' finishes).
  handoffChoice?: 'build' | 'skip'
  // True once the single platform's inline build/tail run has finished (reached
  // build-complete via any path — built, skipped, or failed) → migration done.
  built?: boolean

  // ── tail-input fields (mirror OnboardingProgress's tail fields the shared tail
  // reads — TailEffectProgress). Recorded by applyTailInput as the user answers
  // the tail's CI/CD + build-script prompts. ────────────────────────────────────
  setupMode?: 'undecided' | 'with-workflow' | 'secrets-only' | 'declined'
  ciSecretTarget?: CiSecretTarget | null
  selectedPackageManager?: PackageManager | null
  buildScriptChoice?: BuildScriptChoice | null
  envExportTargetPath?: string
}

export type AppflowInput = {
  value?: string
  field?: string
  text?: string
  // The CI secret destinations detected at `detecting-ci-secrets` (carried on the
  // transient/ctx). Threaded back into `ci-secrets-target-select` so the chosen
  // provider value can be resolved to the FULL CiSecretTarget object instead of
  // being discarded — which would otherwise loop the picker forever (2+ targets).
  ciSecretTargets?: CiSecretTarget[]
}
