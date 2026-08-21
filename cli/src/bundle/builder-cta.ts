import { isCancel as pIsCancel, log, select as pSelect } from '@clack/prompts'
import open from 'open'
import { trackEvent } from '../analytics/track'

export type BuilderCtaSurface = 'skip' | 'ci-ad' | 'prompt-onboarding' | 'prompt-build'
export type BuilderCtaAction = 'continue' | 'abort' | 'launch-onboarding' | 'launch-build'

export interface BuilderCtaContext {
  incompatible: boolean
  interactive: boolean
  hasCredentials: boolean
}

/**
 * Pure decision: which Builder CTA surface (if any) to show for this upload.
 * - `skip`: do nothing (compatible bundle).
 * - `ci-ad`: non-interactive — print a one-off ad, never prompt.
 * - `prompt-onboarding` / `prompt-build`: interactive prompt, branched on
 *   whether the app already has build credentials.
 */
export function decideBuilderCtaSurface(ctx: BuilderCtaContext): BuilderCtaSurface {
  if (!ctx.incompatible)
    return 'skip'
  if (!ctx.interactive)
    return 'ci-ad'
  return ctx.hasCredentials ? 'prompt-build' : 'prompt-onboarding'
}

export interface ShouldBlockIncompatibleUploadContext {
  incompatible: boolean
  failOnIncompatible: boolean
  interactive: boolean
  /** The resolved Builder CTA action (`continue` in CI / when declined). */
  builderAction: BuilderCtaAction
}

/**
 * Pure decision: should an incompatible upload be blocked (abort + exit non-zero)
 * instead of uploaded, given `--fail-on-incompatible`?
 *
 * - Only confirmed-incompatible bundles with the flag set are candidates.
 * - Non-interactive (CI): block immediately.
 * - Interactive: block only when the user declined the Capgo Builder native-build
 *   escape hatch (`builderAction === 'continue'`). Accepting a native build
 *   (`launch-build` / `launch-onboarding`) supersedes the OTA upload, so do not block.
 */
export function shouldBlockIncompatibleUpload(ctx: ShouldBlockIncompatibleUploadContext): boolean {
  if (!ctx.incompatible || !ctx.failOnIncompatible)
    return false
  if (!ctx.interactive)
    return true
  return ctx.builderAction === 'continue'
}

const DOCS_URL = 'https://capgo.app/docs/cli/cloud-build/'
const LEARN_URL = 'https://capgo.app/native-build/'

// Why a native build is needed — folded into the prompt and the CI ad.
const REASON = 'This update includes native changes. An app store update may be required for these changes to take effect. Capgo Builder can help you build and publish the required native update.'

export function printBuilderCiAd(hasCredentials: boolean): void {
  const action = hasCredentials
    ? 'run a native build (npx @capgo/cli build request --platform <ios|android>)'
    : 'set up Capgo Builder (npx @capgo/cli build onboarding)'
  log.warn(`${REASON} To ${action} — learn more: ${LEARN_URL} · docs: ${DOCS_URL}`)
}

export type BuilderCtaChoice = 'yes' | 'no' | 'learn'

interface BuilderSelectOption {
  value: BuilderCtaChoice
  label: string
}

interface BuilderSelectOptions {
  message: string
  options: BuilderSelectOption[]
  initialValue?: BuilderCtaChoice
}

/** Select-prompt seam (`@clack/prompts` `select` satisfies it); injectable for tests. */
export type BuilderSelect = (opts: BuilderSelectOptions) => Promise<BuilderCtaChoice | symbol>

export interface MaybePromptBuilderCtaParams {
  incompatible: boolean
  interactive: boolean
  /** Whether the app already has saved build credentials (resolved by the caller). */
  hasCredentials: boolean
  appId: string
  orgId: string
  apikey: string
  incompatibleCount: number
  /** Injectable for tests; defaults to the `@clack/prompts` select prompt. */
  select?: BuilderSelect
  /** Injectable for tests; defaults to opening the learn page in the browser. */
  openUrl?: (url: string) => Promise<unknown>
}

/**
 * Surface the Capgo Builder CTA for an incompatible upload and return the action
 * the caller should take. Never throws; telemetry and prompt failures degrade to
 * `continue` so the upload is never blocked by the CTA.
 */
export async function maybePromptBuilderCta(params: MaybePromptBuilderCtaParams): Promise<BuilderCtaAction> {
  try {
    return await runBuilderCta(params)
  }
  catch {
    // A CTA failure (prompt, telemetry) must never block the upload.
    return 'continue'
  }
}

async function runBuilderCta(params: MaybePromptBuilderCtaParams): Promise<BuilderCtaAction> {
  const { hasCredentials } = params

  const surface = decideBuilderCtaSurface({
    incompatible: params.incompatible,
    interactive: params.interactive,
    hasCredentials,
  })
  if (surface === 'skip')
    return 'continue'

  const mode: 'build' | 'onboarding' = hasCredentials ? 'build' : 'onboarding'
  void trackEvent({
    channel: 'bundle',
    event: 'Builder CTA Shown',
    apikey: params.apikey,
    appId: params.appId,
    orgId: params.orgId,
    tags: { surface: surface === 'ci-ad' ? 'ci' : 'interactive', mode, incompatible_count: params.incompatibleCount },
  })

  if (surface === 'ci-ad') {
    printBuilderCiAd(hasCredentials)
    return 'continue'
  }

  // Message 1: the context, printed above the prompt so the question stays short.
  log.info(REASON)

  const select = params.select ?? ((opts: BuilderSelectOptions) => pSelect<BuilderCtaChoice>(opts))
  const openUrl = params.openUrl ?? open
  const question = mode === 'build'
    ? 'Start a native build with Capgo Builder now?'
    : 'Would you like to configure Capgo Builder now?'

  while (true) {
    const choice = await select({
      message: question,
      initialValue: 'yes',
      options: [
        { value: 'yes', label: '✅ Yes' },
        { value: 'no', label: '❌ No' },
        { value: 'learn', label: '📖 Learn what Capgo Builder is' },
      ],
    })

    if (pIsCancel(choice))
      return 'abort'

    if (choice === 'learn') {
      void trackEvent({ channel: 'bundle', event: 'Builder CTA Learn Selected', apikey: params.apikey, appId: params.appId, orgId: params.orgId, tags: { mode } })
      try {
        await openUrl(LEARN_URL)
      }
      catch {
        log.warn(`Could not open your browser automatically. Visit: ${LEARN_URL}`)
      }
      continue
    }

    if (choice === 'yes') {
      void trackEvent({ channel: 'bundle', event: 'Builder CTA Accepted', apikey: params.apikey, appId: params.appId, orgId: params.orgId, tags: { mode } })
      return mode === 'build' ? 'launch-build' : 'launch-onboarding'
    }

    // Declined → just continue the OTA upload (no follow-up prompt).
    void trackEvent({ channel: 'bundle', event: 'Builder CTA Declined', apikey: params.apikey, appId: params.appId, orgId: params.orgId, tags: { mode } })
    return 'continue'
  }
}
