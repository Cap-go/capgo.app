// Worst-case fixtures for every STATIC onboarding step, in its COMFORTABLE form
// (dense:false — the only form once the dense flag is dropped). Props are the
// worst cases lifted from the existing frame-fit tests (longest ids/messages,
// most options) so the measured floor is a true upper bound.
//
// Each entry is TAGGED with its platform ('ios' | 'android'), because the floor
// is now PER PLATFORM (see min-terminal-size.ts): iOS steps must fit IOS_MIN_ROWS
// (38), Android steps must fit ANDROID_MIN_ROWS (49). The tag is by source module
// — ios-* → 'ios', android-* → 'android' — which is exact: each app renders ONLY
// its own platform's modules (verified: ui/app.tsx imports ios-*; android/ui/app
// imports android-*), with no cross-platform component sharing.
//
// DYNAMIC / UNBOUNDED steps are intentionally EXCLUDED — they scroll or cut, so
// they don't constrain the static floor:
//   • ai-analysis-prompt / -running / -result  (AI content scrolls)
//   • requesting-build (build log scrolls/tails)
//   • the completed-steps log (cuts to a summary line)
//   • the iOS error screen (ish.ErrorStep) — its recovery advice is unbounded
//     (42–54 rows), so it routes through the same fullscreen scroll viewer as
//     the AI analysis; only its COMPACT form renders inline, and that's ~20 rows.
//
// Each entry: { label, el, withProgress, platform }. withProgress=false for the
// takeover / pre-flow frames that hide the progress bar (welcome, no-platform,
// build-complete, adding-platform).
import React from 'react'
import * as androidCi from '../../src/build/onboarding/ui/steps/android-ci.tsx'
import * as ks from '../../src/build/onboarding/ui/steps/android-keystore.tsx'
import * as sa from '../../src/build/onboarding/ui/steps/android-sa-gcp.tsx'
import * as ash from '../../src/build/onboarding/ui/steps/android-shared.tsx'
import * as cic from '../../src/build/onboarding/ui/steps/ios-ci.tsx'
import * as cred from '../../src/build/onboarding/ui/steps/ios-credentials.tsx'
import * as imp from '../../src/build/onboarding/ui/steps/ios-import.tsx'
import * as ish from '../../src/build/onboarding/ui/steps/ios-shared.tsx'

const h = React.createElement
const noop = () => {}
// The form we ship after dropping the `dense` flag: the COMFORTABLE form (full
// decorations — Alert boxes, spacing). The harness measures THIS so the enforced
// minimum guarantees the real, fully-decorated step fits.
const C = { dense: false }

const LONG_APP_ID = 'com.acme.enterprise.internal.mobile.companion.app'
const LONG_ERR = 'The service account is valid but has no access to this app in the Play Console. Invite capgo-native-build@your-project.iam.gserviceaccount.com under Users and permissions, grant release access, then retry. (HTTP 403 from androidpublisher.edits.insert)'
const ALIASES = ['release', 'upload', 'androiddebugkey', 'mykeyalias', 'prod', 'staging']
const opt = n => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}`, value: `${i}` }))

// CI-secrets worst-case props (shared shape across android-ci + ios-ci; both
// render the same per-provider advice list).
const CI_ADVICE = [
  { target: { provider: 'github', label: 'GitHub Actions repository secrets', cli: 'gh' }, reason: 'not-installed', message: 'GitHub CLI (gh) is not installed or not authenticated.', commands: ['Install GitHub CLI: https://cli.github.com/', 'gh auth login'] },
  { target: { provider: 'gitlab', label: 'GitLab CI/CD variables', cli: 'glab' }, reason: 'not-installed', message: 'GitLab CLI (glab) is not installed or not authenticated.', commands: ['Install GitLab CLI: https://gitlab.com/gitlab-org/cli#installation', 'glab auth login'] },
]
const CI_TARGET = { provider: 'gitlab', label: 'GitLab CI/CD variables', cli: 'glab' }
const CI_KEYS = Array.from({ length: 12 }, (_, i) => `CAPGO_SECRET_ENV_VAR_NUMBER_${i}`)

/** @returns {{ label: string, el: import('react').ReactElement, withProgress: boolean, platform: 'ios' | 'android' }[]} */
export function staticStepFixtures() {
  // f → Android-platform fixture; fi → iOS-platform fixture. Tag is by source
  // module, asserted against that platform's floor in test-onboarding-min-size.
  const f = (label, el, withProgress = true) => ({ label, el, withProgress, platform: 'android' })
  const fi = (label, el, withProgress = true) => ({ label, el, withProgress, platform: 'ios' })
  return [
    // ── android-sa-gcp ──────────────────────────────────────────────────────
    f('google-sign-in', h(sa.GoogleSignInStep, { onChoose: noop, ...C })),
    f('google-sign-in-learn-more', h(sa.GoogleSignInLearnMoreStep, { onBack: noop, ...C })),
    f('service-account-method-select', h(sa.ServiceAccountMethodSelectStep, { onChoose: noop, ...C })),
    f('sa-json-existing-path-chooser', h(sa.SaJsonExistingPathStep, { showChooser: true, onChoosePicker: noop, onChooseManual: noop, onSubmitPath: noop, ...C })),
    f('sa-json-existing-path-manual', h(sa.SaJsonExistingPathStep, { showChooser: false, onChoosePicker: noop, onChooseManual: noop, onSubmitPath: noop, ...C })),
    f('sa-json-validation-failed', h(sa.SaJsonValidationFailedStep, { message: LONG_ERR, onChoose: noop, ...C })),
    f('play-developer-id-actions', h(sa.PlayDeveloperIdActionsStep, { onChoose: noop, ...C })),
    f('play-developer-id-input', h(sa.PlayDeveloperIdInputStep, { onSubmit: noop, ...C })),
    f('gcp-projects-select', h(sa.GcpProjectsSelectStep, { options: [{ label: '➕  Create a new project', value: 'new' }, ...Array.from({ length: 8 }, (_, i) => ({ label: `Project ${i} (project-id-${i})`, value: `proj-${i}` }))], onChange: noop, ...C })),
    f('gcp-project-create-name', h(sa.GcpProjectCreateNameStep, { onSubmit: noop, ...C })),
    f('android-package-select', h(sa.AndroidPackageSelectStep, { packages: ['com.x.y', 'com.a.b'], onSelect: noop, ...C })),
    // ── android-keystore ────────────────────────────────────────────────────
    f('keystore-method-select', h(ks.KeystoreMethodSelectStep, { onChoose: noop, ...C })),
    f('keystore-explainer', h(ks.KeystoreExplainerStep, { onBack: noop, ...C })),
    f('keystore-existing-store-password', h(ks.KeystoreExistingStorePasswordStep, { onSubmit: noop, ...C })),
    f('keystore-existing-alias-select', h(ks.KeystoreExistingAliasSelectStep, { aliases: ALIASES, onSelect: noop, ...C })),
    f('keystore-existing-alias', h(ks.KeystoreExistingAliasStep, { onSubmit: noop, ...C })),
    f('keystore-existing-key-password', h(ks.KeystoreExistingKeyPasswordStep, { mode: 'prompt', onSubmit: noop, ...C })),
    f('keystore-new-alias', h(ks.KeystoreNewAliasStep, { onSubmit: noop, ...C })),
    f('keystore-new-password-method', h(ks.KeystoreNewPasswordMethodStep, { onChoose: noop, ...C })),
    f('keystore-new-store-password', h(ks.KeystoreNewStorePasswordStep, { onSubmit: noop, ...C })),
    f('keystore-new-key-password', h(ks.KeystoreNewKeyPasswordStep, { onSubmit: noop, ...C })),
    f('keystore-new-common-name', h(ks.KeystoreNewCommonNameStep, { appId: LONG_APP_ID, onSubmit: noop, ...C })),
    // ── ios-credentials ─────────────────────────────────────────────────────
    fi('credentials-exist', h(cred.CredentialsExistStep, { appId: LONG_APP_ID, onChange: noop, ...C })),
    fi('setup-method-select', h(cred.SetupMethodSelectStep, { onChange: noop, ...C })),
    fi('api-key-instructions', h(cred.ApiKeyInstructionsStep, { canUseFilePicker: true, onMethodChange: noop, onPathSubmit: noop, ...C })),
    fi('input-key-id', h(cred.InputKeyIdStep, { keyId: '', onSubmit: noop, ...C })),
    fi('input-issuer-id', h(cred.InputIssuerIdStep, { onSubmit: noop, ...C })),
    fi('cert-limit-prompt', h(cred.CertLimitPromptStep, { existingCount: 3, options: opt(2), onChange: noop, ...C })),
    fi('duplicate-profile-prompt', h(cred.DuplicateProfilePromptStep, { duplicateCount: 4, onChange: noop, ...C })),
    // ── ios-import ──────────────────────────────────────────────────────────
    fi('import-distribution-mode', h(imp.ImportDistributionModeStep, { onChange: noop, ...C })),
    fi('import-pick-identity', h(imp.ImportPickIdentityStep, { identityCount: 12, options: opt(12), onChange: noop, ...C })),
    fi('import-export-warning', h(imp.ImportExportWarningStep, { identityName: 'Apple Distribution: Acme Enterprise Inc (ABCDE12345)', onChange: noop, ...C })),
    // ── ios-ci (iOS CI-secrets sub-flow — previously UNMEASURED) ─────────────
    fi('ios-ci-secrets-setup', h(cic.CiSecretsSetupStep, { advice: CI_ADVICE, onChange: noop, ...C })),
    fi('ios-ci-secrets-target-select', h(cic.CiSecretsTargetSelectStep, { options: opt(3), onChange: noop, ...C })),
    fi('ios-ask-ci-secrets', h(cic.AskCiSecretsStep, { entryCount: 12, target: CI_TARGET, targetLabel: 'GitLab CI/CD', onChange: noop, ...C })),
    fi('ios-confirm-ci-secret-overwrite', h(cic.ConfirmCiSecretOverwriteStep, { existingKeys: CI_KEYS, onChange: noop, ...C })),
    fi('ios-ci-secrets-failed', h(cic.CiSecretsFailedStep, { error: LONG_ERR, onChange: noop, ...C })),
    fi('ios-ask-build', h(cic.AskBuildStep, { onChange: noop, ...C })),
    // ── ios-shared (takeover / pre-flow frames — previously UNMEASURED) ──────
    // NOTE: ish.ErrorStep is deliberately NOT here — it's unbounded and scrolls
    // (see header). Only its compact form renders inline, and that's ~20 rows.
    fi('ios-no-platform', h(ish.NoPlatformStep, { iosDir: 'apps/mobile/platforms/ios-native', addIosCommand: 'npx cap add ios', syncIosCommand: 'npx cap sync ios', onChange: noop, ...C }), false),
    fi('ios-build-complete', h(ish.BuildCompleteStep, { buildUrl: `https://console.capgo.app/app/${LONG_APP_ID}/builds`, ciSecretUploadSummary: 'Uploaded 12 secrets to GitHub Actions repository secrets', buildRequestCommand: `npx @capgo/cli build --app ${LONG_APP_ID}`, ...C }), false),
    fi('ios-platform-select', h(ish.PlatformSelectStep, { appId: LONG_APP_ID, onChange: noop, ...C })),
    fi('ios-adding-platform', h(ish.AddingPlatformStep, { addIosCommand: 'npx cap add ios', doctorCommand: 'npx @capgo/cli doctor', ...C }), false),
    // ── shared (rendered by the Android app) ─────────────────────────────────
    fi('welcome', h(ish.WelcomeStep), false),
    f('no-platform', h(ash.NoPlatformStep, { androidDir: 'apps/mobile/platforms/android-native', ...C }), false),
    f('credentials-exist-choose', h(ash.CredentialsExistStep, { appId: 'com.x.y', onChoose: noop, ...C })),
    f('build-complete', h(ash.BuildCompleteStep, { uploadSummary: null, buildUrl: 'https://console.capgo.app/app/com.example.app/builds', ...C }), false),
    f('error', h(ash.ErrorStep, { message: LONG_ERR, onChoose: noop, ...C })),
    // ── ci ──────────────────────────────────────────────────────────────────
    f('ci-secrets-setup', h(androidCi.CiSecretsSetupStep, { advice: CI_ADVICE, onChoose: noop, ...C })),
    f('ci-secrets-target-select', h(androidCi.CiSecretsTargetSelectStep, { options: opt(8), onChange: noop, ...C })),
    f('ask-ci-secrets', h(androidCi.AskCiSecretsStep, { entryCount: 12, targetLabel: 'GitLab CI/CD', cli: 'glab', onChoose: noop, ...C })),
  ]
}
