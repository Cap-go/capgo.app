import { z } from 'zod'

// Input schema for the guided Capgo Builder onboarding `next_step` MCP tool.
// Shared so the runtime validation and the handler's TS type stay in sync.

export const onboardingNextStepSchema = z.object({
  platform: z.enum(['ios', 'android']).optional().describe('Platform choice, when the previous step asked for it'),
  serviceAccountJsonPath: z.string().describe('Path to your Google Play service-account JSON file, when the previous step asked for it').optional(),
  runBuild: z.boolean().describe('Set false (with platform) to SKIP the first cloud build and finish onboarding. The build itself is run with the start_capgo_build tool, not here — passing true is rejected with a pointer to start_capgo_build.').optional(),
  keyId: z.string().describe('App Store Connect Key ID (iOS), when asked').optional(),
  issuerId: z.string().describe('App Store Connect Issuer ID (iOS), when asked').optional(),
  p8Path: z.string().describe('Path to your App Store Connect .p8 key file (iOS), when asked').optional(),
  serviceAccountMethod: z.enum(['generate', 'existing']).describe('Android service-account setup method: "generate" (via Google sign-in) or "existing" (your own JSON), when the step asks you to choose').optional(),
  playDeveloperId: z.string().describe('Your Google Play Console developer ID or Play Console URL (Android OAuth), when asked').optional(),
  gcpProjectId: z.string().describe('Google Cloud project id to host the service account, or "__new__" to create one, when choosing').optional(),
  gcpProjectName: z.string().describe('Display name for a new Google Cloud project, when creating one').optional(),
  androidPackage: z.string().describe('The Android applicationId / package name to grant release access to, when asked').optional(),
  androidVerifyAction: z.enum(['open', 'recheck', 'cancel', 'proceed']).describe('Answer to the Android verify-app gate (android-app-verify) when the chosen package does not match an app in Play Console: "open" to surface the Play Console create-app page, "recheck" to re-run the apps:search check after creating/fixing the app, "proceed" to advance anyway (the app exists but apps:search has not propagated it yet), or "cancel" to stop onboarding. For a wrong-package match, prefer calling next_step again with a corrected androidPackage instead.').optional(),
  saMethodChoice: z.enum(['retry', 'save-anyway', 'oauth']).describe('Recovery choice at service-account validation failure').optional(),
  reopenSignIn: z.boolean().describe('Set true at the Google sign-in step to (re)open the browser for a fresh Google authorization — use this when the browser did not open, was closed, or the sign-in stalled on "still waiting", so the user is never stuck').optional(),
  openSignInBrowser: z.boolean().describe("At the Google sign-in step: set true to have the assistant open the sign-in link in the user's browser for them; set false (or omit) when the user will open the shown link themselves. The link is always returned in the step result either way.").optional(),
  confirmCode: z.string().describe('The confirmation code shown on the Google sign-in success page (e.g. "ABCD-2345"), read back by the user — provide it at the Google sign-in step to finish connecting their Google account. Required to complete sign-in via the MCP.').optional(),
  checkBuild: z.boolean().describe('Set true to record a finished cloud build and continue setup — call it only after start_capgo_build / capgo_build_wait reports the build completed.').optional(),
  resumeChoice: z.enum(['continue', 'restart']).describe('Answer to the resume prompt shown when an in-progress onboarding for the chosen platform already exists: "continue" picks up from the saved step, "restart" wipes the saved onboarding progress for that platform and begins again').optional(),
  credentialsExistChoice: z.enum(['backup', 'cancel']).describe('Data-safety choice when saved Android credentials already exist: "backup" (back them up, then continue) or "cancel" (stop onboarding), when the step asks').optional(),
  keystoreMethod: z.enum(['existing', 'generate']).describe('Whether you already have an Android keystore ("existing") or want one created ("generate")').optional(),
  keystorePath: z.string().describe('Absolute path to your existing Android keystore file (.jks/.keystore/.p12), when asked').optional(),
  keystoreStorePassword: z.string().describe('The keystore store password, when asked').optional(),
  keystoreAlias: z.string().describe('The key alias inside the keystore, when asked or when multiple are found').optional(),
  keystoreKeyPassword: z.string().describe('The key password (leave blank to match the store password), when asked').optional(),
  keystoreNewAlias: z.string().describe('Alias for a newly generated keystore (default "release"), when generating').optional(),
  keystorePasswordMethod: z.enum(['random', 'manual']).describe('For a new keystore: generate a random password or set your own').optional(),
  keystoreCommonName: z.string().describe('Certificate Common Name for a new keystore (defaults to the app id)').optional(),
  verifyAction: z.enum(['pick', 'create-new', 'autofix', 'continue', 'recheck', 'open', 'reopen', 'back', 'cancel']).describe('Answer to the iOS verify-app gate: "pick" an existing App Store app (with verifyAppId), "create-new" when the build id is correct and no app matches, "autofix" to rewrite the Xcode bundle id, "continue"/"recheck" to re-check after a manual fix, "open"/"reopen" to (re)surface the App Store Connect create-app page, "back" to return to the app picker, or "cancel" to stop').optional(),
  verifyAppId: z.string().describe('The bundle id of the App Store app picked at the iOS verify-app step — only together with verifyAction "pick"').optional(),
  certToRevoke: z.string().describe('Answer to the iOS cert-limit-prompt: the Apple resource id of the Distribution certificate to revoke (frees a slot so a new one can be created), or "__exit__" to stop').optional(),
  duplicateProfileAction: z.enum(['delete', 'exit']).describe('Answer to the iOS duplicate-profile-prompt: "delete" removes the duplicate Capgo provisioning profile(s) and recreates a fresh one, "exit" stops onboarding').optional(),
  errorAction: z.enum(['retry', 'restart', 'exit', 'email-support']).describe('Answer to the iOS error recovery screen: "retry" re-runs the failing step, "restart" wipes onboarding progress and starts over, "exit" stops here, "email-support" returns instructions for contacting Capgo support').optional(),
  ciSecretAction: z.enum(['github', 'gitlab', 'skip', 'yes', 'no', 'replace', 'retry', 'continue', 'confirm', 'cancel']).describe('Answer to the post-build CI-secrets steps — the allowed values per step: ci-secrets-target-select "github"/"gitlab"/"skip"; ask-ci-secrets "yes"/"no"; confirm-ci-secret-overwrite "replace"/"skip"; confirm-secrets-push "confirm"/"cancel"; ci-secrets-setup "retry"/"skip"; ci-secrets-failed "retry"/"continue"').optional(),
  githubActionsSetup: z.enum(['with-workflow', 'secrets-only', 'no']).describe('Answer to ask-github-actions-setup: "with-workflow" pushes the secrets AND writes a workflow file, "secrets-only" pushes only the secrets, "no" declines (offers a local .env export instead)').optional(),
  exportEnvAction: z.enum(['yes', 'no', 'replace', 'skip']).describe('Answer to the .env export steps: ask-export-env "yes" (optionally with envExportPath)/"no"; confirm-env-export-overwrite "replace"/"skip"').optional(),
  envExportPath: z.string().describe('Custom target path for the exported .env file — only together with exportEnvAction "yes" (defaults to the path shown in the prompt)').optional(),
  packageManager: z.enum(['bun', 'npm', 'pnpm', 'yarn']).describe('Answer to pick-package-manager: the package manager the generated workflow should install with').optional(),
  buildScript: z.string().describe('Answer to pick-build-script: a script name from the listed options, "__custom__" to type a custom command, or "__skip__" when the app needs no build step').optional(),
  buildScriptCustom: z.string().describe('Answer to pick-build-script-custom: the exact custom command the workflow runs to build the web assets (e.g. "make web")').optional(),
  workflowFileAction: z.enum(['write', 'view', 'cancel']).describe('Answer to preview-workflow-file: "write" writes the workflow file, "view" returns the proposed file content (and re-asks), "cancel" skips writing it').optional(),
  setupMethod: z.enum(['create-new', 'import-existing']).describe('Answer to the iOS setup-method-select fork: "create-new" mints a fresh certificate + profile via the App Store Connect API; "import-existing" reuses a distribution certificate + provisioning profile already on this Mac (Keychain + Xcode profiles, macOS only)').optional(),
  importDistribution: z.enum(['app_store', 'ad_hoc', '__cancel__']).describe('Answer to iOS import-distribution-mode: "app_store" (TestFlight upload, needs an ASC API key), "ad_hoc" (direct/QR install, no ASC key), or "__cancel__" to switch to the create-new path').optional(),
  identityChoice: z.string().describe('Answer to iOS import-pick-identity: the chosen signing identity\'s SHA-1 (one of the listed option values), or "__cancel__" to switch to creating a fresh certificate').optional(),
  profileChoice: z.string().describe('Answer to iOS import-pick-profile: the chosen provisioning profile\'s UUID (one of the listed option values), or "__back__" to return to identity selection').optional(),
  importRecoveryAction: z.enum(['create', 'provide-profile-path', 'browser', 'back']).describe('Answer to iOS import-no-match-recovery: "create" makes a fresh App Store profile for the chosen certificate via Apple, "provide-profile-path" supplies a .mobileprovision file path, "browser" explains the manual Apple Developer Portal route, "back" returns to identity selection').optional(),
  portalAction: z.enum(['use-create', 'open-anyway', 'use-file', 'back']).describe('Answer to iOS import-portal-explanation: "use-create" creates the profile automatically (recommended), "use-file" provides a downloaded .mobileprovision path, "open-anyway"/"back" return to the recovery menu (the portal URL is in the result context — the server never opens a browser)').optional(),
  profilePath: z.string().describe('Absolute path to a .mobileprovision file — answers iOS import-provide-profile-path, when asked').optional(),
  exportConfirm: z.enum(['go', 'back', 'exit']).describe('Answer to iOS import-export-warning: "go" exports the certificate from the macOS Keychain now (the user must approve the one Keychain permission dialog — tell them to click "Always Allow"), "back" returns to profile selection, "exit" stops onboarding').optional(),
})

export type OnboardingNextStepInput = z.infer<typeof onboardingNextStepSchema>

export const onboardingStartInputSchema = z.object({
  platform: z.enum(['ios', 'android']).optional().describe('Set up (or switch to) a specific platform directly: "ios" or "android". Pass it when the user already said which platform, or to switch platforms; omit to be asked.'),
})

export const onboardingExplainInputSchema = z.object({
  state: z.string().optional().describe('Optional state name to explain (from a prior result state field). Omit to explain the current step.'),
})
