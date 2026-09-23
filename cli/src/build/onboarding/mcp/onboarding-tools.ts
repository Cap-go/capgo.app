// src/build/onboarding/mcp/onboarding-tools.ts
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import process from 'node:process'
import type { CapgoSDK } from '../../../sdk.js'
import type { OnboardingNextStepInput } from '../../../schemas/onboarding.js'
import { isAppAlreadyExistsError } from '../../../init/app-conflict.js'
import { onboardingExplainInputSchema, onboardingNextStepSchema, onboardingStartInputSchema } from '../../../schemas/onboarding.js'
import type { McpRegistrar } from '../../../mcp/registrar.js'
import { findBuildCommandForProjectType, findProjectType, findSavedKeySilent, getAppId, getConfig, getPackageScripts } from '../../../utils.js'
import { findPackageManagerType } from '@capgo/find-package-manager'
import { loadSavedCredentials, updateSavedCredentials } from '../../credentials.js'
import { getPlatformDirFromCapacitorConfig } from '../../platform-paths.js'
import type { AndroidEffectDeps } from '../android/flow.js'
import type { IosEffectDeps } from '../ios/flow.js'
import { findAndroidApplicationIds } from '../android/gradle-parser.js'
import { generateKeystore, listKeystoreAliases, sanitizeKeystoreAlias, tryUnlockPrivateKey } from '../android/keystore.js'
import { fetchCapgoOAuthConfig } from '../android/oauth-config.js'
import { createCiSecretEntries, detectCiSecretTargets, getCiSecretRepoLabelAsync, listExistingCiSecretKeysAsync, uploadCiSecretsAsync } from '../ci-secrets.js'
import { defaultExportPath, exportCredentialsToEnv } from '../env-export.js'
import { generateWorkflow } from '../workflow-generator.js'
import { writeWorkflowFile } from '../workflow-writer.js'
import { fetchUserInfo, revokeToken, runOAuthFlow, startOAuthFlow } from '../android/oauth-google.js'
import open from 'open'

import { OAUTH_REQUIRED_SCOPES, OAUTH_SCOPES_FOR_ONBOARDING } from '../android/oauth-scopes.js'
import { createProject, createServiceAccountKey, enableService, ensureServiceAccount, listProjects } from '../android/gcp-api.js'
import { listPlayApps } from '../android/reporting-api.js'
import { inviteServiceAccount } from '../android/play-api.js'
import { deleteAndroidProgress, loadAndroidProgress, saveAndroidProgress } from '../android/progress.js'
import { validateServiceAccountJson } from '../android/service-account-validation.js'
import type { AscDistributionCert } from '../apple-api.js'
import { classifyCertAvailability, computeCertSha1, createCertificate, createProfile, deleteProfile, ensureBundleId, findCertIdBySha1, generateJwt, listApps, listBundleIds, listDistributionCerts, listProfilesForCert, revokeCertificate, verifyApiKey } from '../apple-api.js'
import { exportP12FromKeychain, listSigningIdentities, scanProvisioningProfiles } from '../macos-signing.js'
import { parseMobileprovisionBufferDetailed } from '../../mobileprovision-parser.js'
import { createP12, generateCsr } from '../csr.js'
import { detectIosBundleIds } from '../bundle-id-detector.js'
import { writeReleaseBundleId } from '../../pbxproj-parser.js'
import { deleteProgress, loadProgress, saveProgress } from '../progress.js'
import { defaultBuildRecordPath, readBuildOutputRecord, removeBuildOutputRecord } from '../../output-record.js'
import type { Platform } from './contract.js'
import { renderResult } from './contract.js'
import type { EngineDeps } from './engine.js'
import { explainOnboarding, runAdvance, runStart } from './engine.js'
import { getSession } from './session-state.js'
import type { BuildJobDeps } from './build-job.js'
import { buildJobDeps, registerBuildTools } from './build-tools.js'
import { type CredentialsManageDeps, registerCredentialsManageTool } from './credentials-manage.js'



/**
 * Build the AndroidEffectDeps wiring that the MCP bridge (Task 4) will use
 * to drive the headless core. The function pre-binds the OAuth client config
 * and the android project dir so the core never sees credentials or paths
 * directly — config policy lives here in the driver.
 */
function buildAndroidEffectDeps(
  cwd: string,
  getAppIdFn: () => Promise<string | undefined>,
): AndroidEffectDeps {
  // Local OAuth config cache — fetched once per buildAndroidEffectDeps lifetime.
  let configCache: Awaited<ReturnType<typeof fetchCapgoOAuthConfig>> | undefined

  async function getConfig_(): Promise<NonNullable<Awaited<ReturnType<typeof fetchCapgoOAuthConfig>>>> {
    if (configCache === undefined) {
      configCache = await fetchCapgoOAuthConfig()
    }
    if (!configCache) {
      throw new Error(
        'Android OAuth onboarding is not available — the Capgo backend has no Google OAuth client configured. '
        + 'Use the manual service-account flow instead.',
      )
    }
    return configCache
  }

  async function getAccessToken(): Promise<string> {
    // Broker model: the MCP cannot refresh a token issued to the broker's confidential Web client, so it uses
    // the short-lived access token persisted at sign-in and re-signs-in once it expires (60s safety margin).
    const appId = await getAppIdFn()
    if (!appId)
      throw new Error('Not signed in — re-run onboarding to re-authenticate with Google.')
    const progress = await loadAndroidProgress(appId)
    const token = progress?._oauthAccessToken
    const expiresAt = progress?._oauthAccessTokenExpiresAt
    if (!token || !expiresAt || Date.now() >= expiresAt - 60_000)
      throw new Error('Your Google sign-in has expired — re-run the Capgo Builder onboarding to sign in again with Google.')
    return token
  }

  return {
    // ── Keystore ──────────────────────────────────────────────────────────────
    generateKeystore,
    listKeystoreAliases,
    tryUnlockPrivateKey,

    // ── Service account validation ────────────────────────────────────────────
    validateServiceAccountJson,

    // ── Build credentials persistence ─────────────────────────────────────────
    updateSavedCredentials,
    loadSavedCredentials: (appId: string) => loadSavedCredentials(appId),

    // ── Onboarding progress persistence ───────────────────────────────────────
    saveAndroidProgress,
    loadAndroidProgress,
    deleteAndroidProgress,

    // ── File system ───────────────────────────────────────────────────────────
    readFile: (path: string) => readFile(path) as Promise<Buffer>,
    copyFile,

    // ── OAuth ─────────────────────────────────────────────────────────────────
    runOAuthFlow: async (callbacks) => {
      const cfg = await getConfig_()
      return runOAuthFlow(
        { clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: OAUTH_SCOPES_FOR_ONBOARDING, requiredScopes: OAUTH_REQUIRED_SCOPES },
        callbacks,
      )
    },
    startOAuthFlow: async (callbacks) => {
      const cfg = await getConfig_()
      return startOAuthFlow(
        { clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: OAUTH_SCOPES_FOR_ONBOARDING, requiredScopes: OAUTH_REQUIRED_SCOPES },
        callbacks,
      )
    },
    // Open the broker sign-in link in the user's browser when the engine asks (best-effort; the engine shows
    // the link as a fallback). `open` resolves once the OS hands off to the browser — never blocks the tool.
    openBrowser: async (url: string) => { await open(url) },
    fetchUserInfo,
    getAccessToken,
    revokeToken: async (token: string) => revokeToken(token),

    // ── GCP ───────────────────────────────────────────────────────────────────
    listProjects,
    // Play Developer Reporting (apps:search) for android-app-verify.
    listPlayApps: (token: string) => listPlayApps(token),
    createProject,
    enableService,
    ensureServiceAccount,
    createServiceAccountKey,

    // ── Play API ──────────────────────────────────────────────────────────────
    inviteServiceAccount: async (args) => {
      await inviteServiceAccount(args)
    },


    // ── S8: shared post-save tail helpers (mirrors the TUI driver wiring in
    // ui/app.tsx ~L2498-2570 / android/ui/app.tsx — headless: no React sinks).
    // createCiSecretEntries pre-binds the RESOLVED Capgo key (the MCP has no
    // --apikey flag, so the saved key IS the whole precedence chain) so
    // CAPGO_TOKEN reaches the upload + the generated workflow's secret set.
    // The key value rides only the session-registry entries — NEVER tool
    // results or progress.json. The MCP driver persists the SLIM tail progress
    // + markers itself (engine S8); the tail's own saveProgress stays unused
    // by runTailEffect (the never-saveProgress tail rule).
    createCiSecretEntries: creds => createCiSecretEntries(creds, findSavedKeySilent() || undefined),
    detectCiSecretTargets,
    getCiSecretRepoLabelAsync,
    listExistingCiSecretKeysAsync,
    uploadCiSecretsAsync,
    exportCredentialsToEnv,
    defaultExportPath,
    detectPackageManager: () => findPackageManagerType(cwd, 'npm'),
    generateWorkflow,
    writeWorkflowFile,
    getPackageScripts,
    findProjectType,
    findBuildCommandForProjectType,

    // ── Android Gradle detection ──────────────────────────────────────────────
    findAndroidApplicationIds: async () => {
      let androidDir = 'android'
      try {
        const ext = await getConfig(true)
        androidDir = getPlatformDirFromCapacitorConfig(ext?.config, 'android') || 'android'
      }
      catch {
        // Not a Capacitor project or config unreadable — fall back to 'android'
      }
      return findAndroidApplicationIds(androidDir, cwd)
    },
  }
}

/**
 * Build the iOS shared-engine effect deps the MCP driver injects into
 * `decideIos` — headless (NO ink, NO native pickers, NO browser): the
 * counterpart of the TUI's engine-driver wiring in ui/app.tsx, with the raw
 * apple-api helpers adapted from their JWT-token call shape to the engine's
 * abstracted dep shapes via a per-call `getFreshToken` (a fresh ASC JWT minted
 * from the persisted keyId/issuerId + the .p8 bytes — session-carried when
 * present, else re-read from the persisted p8Path so a server restart
 * self-heals).
 *
 * Headless adaptations vs the TUI:
 *  - openExternal is a NO-OP: the MCP server never opens the user's browser —
 *    the verify-app create-app gate surfaces the App Store Connect URL in the
 *    result instead.
 *  - the native file pickers are omitted (p8-method-select never runs on the
 *    MCP path; the single ios-api-key gate collects the path as text).
 */
function buildIosEffectDeps(cwd: string, getAppIdFn: () => Promise<string | undefined>): IosEffectDeps {
  // The bundle-id detector needs the ios platform dir + capacitor appId
  // SYNCHRONOUSLY (the dep mirrors the TUI's memo-bypassing detect call), but
  // both come from the async capacitor-config read. Prime them once up front
  // and make every Apple round-trip await the prime, so by the time verify-app
  // calls detectBundleIds the real values are in place. Until primed the
  // defaults match the overwhelmingly common layout ('ios' + no capacitor id).
  let iosDirCache = 'ios'
  let capacitorAppIdCache = ''
  const primed = (async () => {
    try {
      const ext = await getConfig(true)
      iosDirCache = getPlatformDirFromCapacitorConfig(ext?.config, 'ios') || 'ios'
      capacitorAppIdCache = getAppId(undefined, ext?.config) ?? ''
    }
    catch {
      // Not a Capacitor project / unreadable config — keep the defaults.
    }
  })()

  /** Mint a fresh ASC JWT per call (mirrors the TUI's getFreshToken). */
  async function getFreshToken(): Promise<string> {
    await primed
    const appId = await getAppIdFn()
    if (!appId)
      throw new Error('Cannot mint an App Store Connect token: no app id found in this project.')
    const prog = await loadProgress(appId)
    if (!prog?.keyId || !prog?.issuerId)
      throw new Error('Missing App Store Connect API key details — provide the Key ID, Issuer ID, and .p8 path first.')
    const carriedP8 = getSession(appId).iosCarried.p8Content
    let content = carriedP8 ? carriedP8.toString('utf-8') : undefined
    if (!content && prog.p8Path)
      content = await readFile(prog.p8Path, 'utf-8')
    if (!content)
      throw new Error('The .p8 key file is unavailable — provide the p8Path again.')
    return generateJwt(prog.keyId, prog.issuerId, content)
  }

  // S12: classifyCertAvailability pre-binds the single team-wide cert fetch +
  // SHA-1 index (the TUI import driver's memo, ui/app.tsx ~L2192): one
  // /certificates download, M SHA-1 hashes, then N O(1) lookups — NOT N
  // re-downloads when import-validating-all-certs loops over the identities.
  // SHORT-LIVED: the index expires after 5 minutes so a long-lived MCP server
  // never classifies against a stale cert list (the TUI rebuilds it per
  // effect-driver mount; a tool-call burst within one onboarding shares it).
  let certIndexCache: { promise: Promise<Map<string, AscDistributionCert>>, builtAt: number } | null = null
  function getCertIndex(): Promise<Map<string, AscDistributionCert>> {
    if (!certIndexCache || Date.now() - certIndexCache.builtAt > 5 * 60_000) {
      const promise = (async () => {
        const token = await getFreshToken()
        const allCerts = await listDistributionCerts(token, { includeContent: true })
        const bySha1 = new Map<string, AscDistributionCert>()
        for (const cert of allCerts) {
          if (!cert.certificateContent)
            continue
          bySha1.set(computeCertSha1(cert.certificateContent), cert)
        }
        return bySha1
      })()
      // A failed build must not poison the cache — drop it so the next call retries.
      promise.catch(() => {
        if (certIndexCache?.promise === promise)
          certIndexCache = null
      })
      certIndexCache = { promise, builtAt: Date.now() }
    }
    return certIndexCache.promise
  }

  return {
    // ── apple-api (token-adapted, mirrors ui/app.tsx's engine-driver wiring) ──
    verifyApiKey: async () => {
      const r = await verifyApiKey(await getFreshToken())
      return { teamId: r.teamId }
    },
    createCertificate: async ({ csr }) => createCertificate(await getFreshToken(), csr),
    createProfile: async ({ bundleId, certificateId }) => {
      const token = await getFreshToken()
      const { bundleIdResourceId } = await ensureBundleId(token, bundleId)
      const p = await createProfile(token, bundleIdResourceId, certificateId, bundleId)
      return { profileId: p.profileId, profileName: p.profileName, profileBase64: p.profileContent }
    },
    // Scoped to the DISTRIBUTION pool — same reasoning as the TUI's cert-limit
    // recovery: only same-type revocations free a slot.
    listCertificates: async () => listDistributionCerts(await getFreshToken(), { types: ['DISTRIBUTION'] }),
    // ── cert-limit / duplicate-profile recovery (S6b, mirrors ui/app.tsx) ──
    revokeCertificate: async (certificateId) => {
      await revokeCertificate(await getFreshToken(), certificateId)
    },
    deleteProfile: async (profileId) => {
      await deleteProfile(await getFreshToken(), profileId)
    },

    // ── verify-app (remote App Store verification, PR #2397) ──
    listApps: async () => listApps(await getFreshToken()),
    listBundleIds: async () => listBundleIds(await getFreshToken()),
    detectBundleIds: () => detectIosBundleIds({ cwd, iosDir: iosDirCache, capacitorAppId: capacitorAppIdCache }),
    writeReleaseBundleId: (fromId, toId) => writeReleaseBundleId(cwd, iosDirCache, fromId, toId),
    ensureBundleId: async (bundleId) => {
      await ensureBundleId(await getFreshToken(), bundleId)
    },
    // HEADLESS: never open the user's browser from the MCP server. The engine
    // surfaces the create-app URL in the verify-app gate result instead.
    openExternal: () => {},

    // ── csr (shape-adapted) ──
    generateCsr: () => {
      const r = generateCsr()
      return { csr: r.csrPem, privateKeyPem: r.privateKeyPem }
    },
    createP12: ({ certificatePem, privateKeyPem, password }) =>
      createP12(certificatePem, privateKeyPem, password).p12Base64,

    // ── file system ──
    readFile: (path: string) => readFile(path) as Promise<Buffer>,
    copyFile,
    isMacOS: () => process.platform === 'darwin',

    // ── S12: import-existing sub-flow (macos-signing + apple-api, mirrors the
    // TUI's engine-driven import driver in ui/app.tsx ~L2215-2280). Wiring
    // listSigningIdentities + isMacOS is ALSO what exposes the setup-method
    // fork (engine iosSetupForkStep: capability = macOS AND the scan dep).
    // HEADLESS adaptations: openProfilePicker is NOT wired — decideIos injects
    // a one-shot picker resolving the user-supplied profilePath (the manual
    // arm); openExternal stays a no-op (the portal URL rides the result
    // context instead of a browser open).
    listSigningIdentities,
    scanProvisioningProfiles,
    // exportP12FromKeychain resolves + signature-verifies the precompiled
    // signed helper internally (PR #2458 dropped the swiftc compile path, so
    // there are no precompile/cache deps to wire — same as the TUI driver).
    exportP12FromKeychain,
    // classifyCertAvailability resolves the identity's cert from the memoized
    // SHA-1 index, then enriches via the apple-api classifier — byte-for-byte
    // the TUI driver's wiring (ui/app.tsx ~L2229-2249).
    classifyCertAvailability: async (identity) => {
      const bySha1 = await getCertIndex()
      const cert = bySha1.get(identity.sha1.toLowerCase()) ?? null
      const classified = classifyCertAvailability({
        appleCertId: cert ? cert.id : null,
        lookupError: null,
      })
      return {
        available: classified.available,
        reason: classified.reason,
        reasonText: classified.reasonText,
        appleCertId: classified.appleCertId,
        ...(cert && classified.available
          ? {
              appleCertName: cert.name,
              appleCertExpirationDate: cert.expirationDate,
              appleCertSerialNumber: cert.serialNumber,
            }
          : {}),
      }
    },
    listProfilesForCert: async certId => listProfilesForCert(await getFreshToken(), certId),
    findCertIdBySha1: async sha1 => findCertIdBySha1(await getFreshToken(), sha1),
    // The engine reads the .mobileprovision bytes via deps.readFile then parses
    // them here — wire the BUFFER variant (the path-based parser re-reads the
    // file, which the engine already did at its IO boundary).
    parseMobileprovisionDetailed: bytes => parseMobileprovisionBufferDetailed(bytes),


    // ── S8: shared post-save tail helpers (mirrors the TUI driver wiring in
    // ui/app.tsx ~L2498-2570 / android/ui/app.tsx — headless: no React sinks).
    // createCiSecretEntries pre-binds the RESOLVED Capgo key (the MCP has no
    // --apikey flag, so the saved key IS the whole precedence chain) so
    // CAPGO_TOKEN reaches the upload + the generated workflow's secret set.
    // The key value rides only the session-registry entries — NEVER tool
    // results or progress.json. The MCP driver persists the SLIM tail progress
    // + markers itself (engine S8); the tail's own saveProgress stays unused
    // by runTailEffect (the never-saveProgress tail rule).
    createCiSecretEntries: creds => createCiSecretEntries(creds, findSavedKeySilent() || undefined),
    detectCiSecretTargets,
    getCiSecretRepoLabelAsync,
    listExistingCiSecretKeysAsync,
    uploadCiSecretsAsync,
    exportCredentialsToEnv,
    defaultExportPath,
    detectPackageManager: () => findPackageManagerType(cwd, 'npm'),
    generateWorkflow,
    writeWorkflowFile,
    getPackageScripts,
    findProjectType,
    findBuildCommandForProjectType,

    // ── persistence (the shared tail's saving-credentials needs all of these) ──
    loadProgress,
    saveProgress,
    deleteProgress,
    updateSavedCredentials,
    loadSavedCredentials: (appId: string) => loadSavedCredentials(appId),
  }
}

/**
 * Production EngineDeps wiring. Exported for tests that pin production-only
 * behavior (clearBuildRecord wiring, keystore file modes).
 */
// Takes a LIVE accessor, not a captured instance: capgo_login/capgo_logout reassign
// the server's `let sdk`, and onboarding must act as the currently-signed-in user.
// getSdk() returns the live binding on every call.
export function buildDeps(getSdk: () => CapgoSDK): EngineDeps {
  const cwd = process.cwd()
  const getAppIdClosure = async (): Promise<string | undefined> => {
    try {
      const ext = await getConfig(true)
      return getAppId(undefined, ext?.config)
    }
    catch {
      return undefined
    }
  }
  return {
    cwd,
    hasSavedKey: () => Boolean(findSavedKeySilent()),
    getAppId: getAppIdClosure,
    detectPlatforms: async () => {
      const out: Platform[] = []
      try {
        const ext = await getConfig(true)
        const iosDir = getPlatformDirFromCapacitorConfig(ext?.config, 'ios')
        const androidDir = getPlatformDirFromCapacitorConfig(ext?.config, 'android')
        if (existsSync(join(cwd, iosDir)))
          out.push('ios')
        if (existsSync(join(cwd, androidDir)))
          out.push('android')
      }
      catch {
        // not a Capacitor project — leave empty
      }
      return out
    },
    isAppRegistered: async (appId: string) => {
      // Targeted existence+access check — NOT listApps. The broad apps list times out
      // on large databases (a full-table RBAC RLS scan) and would falsely report an
      // app you OWN as unregistered, which then re-registers it and surfaces a bogus
      // "already exists and is not in your account" conflict.
      const res = await getSdk().appHasAccess(appId)
      return res.success && res.data === true
    },
    loadProgress: (appId: string) => loadProgress(appId),
    registerApp: async (appId: string) => {
      const res = await getSdk().addApp({ appId })
      if (res.success)
        return { ok: true as const }
      const error = res.error || 'Failed to register app'
      return { ok: false as const, alreadyExists: isAppAlreadyExistsError(error), error }
    },
    loadAndroidProgress: (appId: string) => loadAndroidProgress(appId),
    readBuildRecord: readBuildOutputRecord,
    buildRecordPath: defaultBuildRecordPath,
    clearBuildRecord: removeBuildOutputRecord,
    iosEffectDeps: buildIosEffectDeps(cwd, getAppIdClosure),
    androidEffectDeps: buildAndroidEffectDeps(cwd, getAppIdClosure),
    writeKeystoreFile: async (appId: string, base64: string, alias: string): Promise<string> => {
      // Write the generated/loaded keystore to <androidDir>/app/<alias>.p12. The
      // android dir is resolved from capacitor.config (custom `android.path`
      // projects exist — CodeRabbit #2394) exactly like findAndroidApplicationIds
      // above; falls back to 'android' when the config is unreadable.
      // `alias` comes from user input — sanitize it for the ON-DISK filename only
      // (the crypto alias / KEYSTORE_KEY_ALIAS keep the user's exact value).
      let androidDir = 'android'
      try {
        const ext = await getConfig()
        androidDir = getPlatformDirFromCapacitorConfig(ext?.config, 'android') || 'android'
      }
      catch {
        // Not a Capacitor project or config unreadable — fall back to 'android'.
      }
      const androidAppDir = join(cwd, androidDir, 'app')
      await mkdir(androidAppDir, { recursive: true })
      const safe = sanitizeKeystoreAlias(alias)
      const filePath = join(androidAppDir, `${safe}.p12`)
      // Defense-in-depth: the resolved path must stay inside androidAppDir.
      const resolvedDir = resolve(androidAppDir)
      const resolvedFile = resolve(filePath)
      if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(resolvedDir + sep))
        throw new Error('Refusing to write keystore outside the android app directory.')
      const bytes = Buffer.from(base64, 'base64')
      // Owner-only: the .p12 holds the signing private key (hostile-review 2026-06-12).
      await writeFile(filePath, bytes, { mode: 0o600 })
      return filePath
    },
  }
}

/**
 * Register the 2-tool onboarding spine onto an MCP server.
 * `depsOverride` is for tests; production passes only `server` + `sdk`.
 */
export function registerOnboardingTools(server: McpRegistrar, getSdk: () => CapgoSDK, depsOverride?: EngineDeps, buildJobDepsOverride?: BuildJobDeps, credentialsManageDepsOverride?: CredentialsManageDeps): void {
  const deps = depsOverride ?? buildDeps(getSdk)

  server.registerTool(
    'start_capgo_builder_onboarding',
    {
      description: 'Start (or resume) the guided, tool-driven Capgo Builder setup for native iOS/Android cloud builds — App Store / Play credentials, certificates, keystores, signing, and the first cloud build. ALWAYS call this FIRST, and let it conduct the whole flow, whenever the user wants to set up, configure, connect, enable, or troubleshoot Capgo Builder, native builds, cloud builds, or signing. Do NOT inspect the repo, read config files, or web-search to do this yourself — this tool inspects the project and returns the exact next step to take. Optionally pass platform "ios" or "android" to set up (or SWITCH to) that platform directly — pass it when the user already named one ("set up Capgo Builder for iOS") or wants to switch after a wrong pick; omit it to let the tool ask. Do NOT call this tool to retry, skip, restart, or "continue past" a cloud build that already FAILED inside onboarding: a failed build is a REQUIRED gate, retried only with start_capgo_build once the user has addressed the cause — never by re-entering onboarding here.',
      inputSchema: onboardingStartInputSchema,
    },
    async (args: { platform?: 'ios' | 'android' }) => {
      const result = await runStart(deps, args.platform)
      return { content: [{ type: 'text' as const, text: renderResult(result) }] }
    },
  )

  server.registerTool(
    'capgo_builder_onboarding_next_step',
    {
      description: 'Advance the guided Capgo Builder onboarding by one step. Call ONLY as directed by the previous result\'s `next`. Pass the user\'s choice (e.g. platform) when the previous step asked for one. Never call this to skip, retry, restart, or "continue past" a cloud build that FAILED — a failed build is retried only with start_capgo_build, never by advancing onboarding here.',
      inputSchema: onboardingNextStepSchema,
    },
    async (args: OnboardingNextStepInput) => {
      const result = await runAdvance(deps, args)
      return { content: [{ type: 'text' as const, text: renderResult(result) }] }
    },
  )

  server.registerTool(
    'capgo_builder_onboarding_explain',
    {
      description: 'Explain a Capgo Builder onboarding step in plain language — call this whenever the user is confused, asks what a step means, or does not understand the options. Defaults to the CURRENT step; pass { state } to explain a specific one (e.g. a build-phase state like "build-waiting" whose protocol context is not on disk). Read-only; it never advances the flow.',
      inputSchema: onboardingExplainInputSchema,
    },
    async (args: { state?: string }) => {
      const text = await explainOnboarding(deps, args)
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  // ── Cloud-build tools (start / wait / logs / cancel) ─────────────────────────
  // The build phase runs the first cloud build via a tracked background child
  // (no Terminal.app/AppleScript) + bounded-wait polling. The onboarding
  // build-ready step points the agent at start_capgo_build; a COMPLETED build
  // hands back to capgo_builder_onboarding_next_step({ checkBuild }) for the tail.
  registerBuildTools(server, deps.getAppId, buildJobDepsOverride ?? buildJobDeps(deps.cwd))

  // ── Credentials management (post-onboarding) ─────────────────────────────────
  // Manage credentials that ALREADY exist: export to .env, or add/edit/remove a
  // field. Refuses (and points at onboarding) when no credentials exist for the app.
  registerCredentialsManageTool(server, deps.getAppId, credentialsManageDepsOverride)
  // ── Discoverable, client-agnostic entry point (MCP prompt) ──────────────────
  // Clients that support MCP prompts surface this as a slash command (e.g.
  // /capgo-builder-setup). Invoking it injects the message below, which kicks
  // off the tool-driven flow — so the user never has to name the tool, and the
  // agent is told NOT to improvise the setup itself.
  server.registerPrompt(
    'capgo-builder-setup',
    { description: 'Set up Capgo Builder native cloud builds (iOS/Android signing + first build) — starts the guided, tool-driven onboarding.' },
    () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Set up Capgo Builder for native cloud builds in this project. Do it by calling the start_capgo_builder_onboarding tool now, then follow the `next` instruction in each result — calling capgo_builder_onboarding_next_step / capgo_builder_onboarding_explain exactly as directed — until setup is complete. Do NOT configure Capgo manually, read config files, or search the web: the onboarding tools conduct the entire flow.',
        },
      }],
    }),
  )
}
