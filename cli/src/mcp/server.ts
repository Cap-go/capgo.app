import type { ProtocolEra } from '@modelcontextprotocol/server'
import type { SDKResult } from '../schemas/sdk'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import pack from '../../package.json'
import { enableApiInstrumentation, setInvocationSource, trackMcpServerStarted, withMcpToolTracking } from '../analytics/track'
import { starAllRepositoriesOptionsSchema, starRepoOptionsSchema } from '../schemas/sdk'
import {
  mcpCheckCompatibilityInputSchema,
  mcpDoctorInputSchema,
  mcpGenerateEncryptionKeysInputSchema,
  mcpProbeInputSchema,
  mcpRequestBuildInputSchema,
  mcpUploadBundleInputSchema,
  mcpSetProjectDirInputSchema,
  mcpProjectDirOptionSchema,
  mcpCwdOptionSchema,
} from './tool-schemas'
import { CapgoSDK } from '../sdk'
import { getConfigWriteTarget, setConfigWriteTarget } from '../config'
import { clearSavedKey, getLoginState, loginSuccessMessage, logoutMessage, validateAndSaveKey, whoamiMessage } from '../auth/session'
import { mcpLoginInputSchema, mcpLogoutInputSchema } from '../schemas/auth'
import { findSavedKeySilent, formatError } from '../utils'
import { registerOnboardingTools } from '../build/onboarding/mcp/onboarding-tools'
import { withCwd } from '../build/cwd'
import { registerLiveUpdateTools } from '../init/mcp/live-update-tools'
import { withErrorGuidance, withGuidedErrorResults } from './error-guidance'
import { buildServerInstructions } from './instructions'
import { installMcpStdoutGuard } from './stdout-guard'
import { createProjectDirQueue, describeProjectDir, pickProjectDirFromRoots, resolveProjectDirInput, resolveProjectDirOptions } from './project-dir'

/**
 * Format an SDK result error for MCP response.
 * Provides detailed error messages for security policy errors.
 */
function formatMcpError<T>(result: SDKResult<T>): { content: Array<{ type: 'text', text: string }>, isError: true } {
  let errorMessage = result.error || 'Unknown error'

  // If it's a security policy error, use the detailed message
  if (result.isSecurityPolicyError && result.securityPolicyMessage) {
    errorMessage = `Security Policy Error:\n\n${result.securityPolicyMessage}`
  }

  return {
    content: [{ type: 'text' as const, text: errorMessage }],
    isError: true,
  }
}
/**
 * Start the Capgo MCP (Model Context Protocol) server.
 * Local project operations complement the hosted MCP cloud tools.
 */
export async function startMcpServer(capacitorConfigTarget?: string): Promise<void> {
  const previousConfigWriteTarget = getConfigWriteTarget()
  let restored = false
  const restoreConfigWriteTarget = () => {
    if (restored)
      return
    restored = true
    setConfigWriteTarget(previousConfigWriteTarget)
  }

  setConfigWriteTarget(capacitorConfigTarget)
  try {
    await startMcpServerInternal(restoreConfigWriteTarget)
  }
  catch (error) {
    restoreConfigWriteTarget()
    throw error
  }
}

async function startMcpServerInternal(restoreConfigWriteTarget: () => void): Promise<void> {
  // Install the stdout guard FIRST, before any startup code (saved-key lookup, SDK init,
  // lazily imported deps) can emit a stray clack/console line. It reroutes ambient stdout
  // to stderr and returns the ONLY writer allowed to reach the real stdout for JSON-RPC
  // frames. Installing it late (after this code ran) let a no-key "please login" clack
  // line land on stdout and corrupt the initialize handshake.
  const transportStdout = installMcpStdoutGuard()

  setInvocationSource('mcp')
  enableApiInstrumentation()

  const transport = new StdioServerTransport(process.stdin, transportStdout)
  const send = transport.send.bind(transport)
  transport.send = (message: Parameters<typeof send>[0]) => send(withGuidedErrorResults(message))
  const close = transport.close.bind(transport)
  transport.close = async () => {
    try {
      await close()
    }
    finally {
      restoreConfigWriteTarget()
    }
  }
  const start = transport.start.bind(transport)
  const started = new Promise<void>((resolve, reject) => {
    transport.start = async () => {
      try {
        await start()
        resolve()
      }
      catch (error) {
        reject(error)
        throw error
      }
    }
  })
  // The SDK preserves legacy initialize/roots while also accepting modern discovery.
  serveStdio(({ era }) => createMcpServer(era), { transport })
  await started
  trackMcpServerStarted(Boolean(findSavedKeySilent()))
}

function createMcpServer(era: ProtocolEra): McpServer {
  // Computed once: gates BOTH the onboarding-tool registration (below) and the
  // onboarding steer appended to the server instructions, so we never advertise a
  // start_capgo_builder_onboarding tool we didn't actually register.
  const onboardingEnabled = Boolean(globalThis.__CAPGO_MCP_ONBOARDING__)
  const liveUpdateEnabled = Boolean(globalThis.__CAPGO_MCP_LIVE_UPDATE__)
  const server = new McpServer(
    { name: 'capgo', version: pack.version },
    { instructions: buildServerInstructions({ onboardingEnabled, liveUpdateEnabled }) },
  )

  // Project directory: the server reads the user's project (capacitor config, package.json,
  // native folders, ./.capgo) from process.cwd(). A user-scoped install is spawned from the
  // client's dir (often ~ or /), not the agent's workspace, so follow the client's MCP roots
  // once initialized and on roots/list_changed. capgo_set_project_dir overrides both.
  let projectDirSync: Promise<void> = Promise.resolve()
  let selectedProjectDir = process.cwd()
  let projectDirPinned = false
  let projectDirError: unknown
  const runInProjectDir = createProjectDirQueue()
  const syncProjectDirFromRoots = (): Promise<void> => runInProjectDir(async () => {
    if (projectDirPinned)
      return
    try {
      const { roots } = server.server.getClientCapabilities()?.roots
        ? await server.server.listRoots(undefined, { timeout: 5000 })
        : { roots: [{ uri: pathToFileURL(selectedProjectDir).href }] }
      let dir: string | undefined
      try {
        dir = await pickProjectDirFromRoots(roots, selectedProjectDir)
        projectDirError = undefined
      }
      catch (error) {
        projectDirError = error
        return
      }
      if (!projectDirPinned && dir && dir !== selectedProjectDir) {
        selectedProjectDir = dir
        refreshSdkForProject()
      }
    }
    catch {
      // Client advertised roots but did not answer: keep the spawn dir; the agent can
      // still call capgo_set_project_dir.
    }
  })
  server.server.oninitialized = () => {
    projectDirSync = syncProjectDirFromRoots()
  }
  server.server.setNotificationHandler('notifications/roots/list_changed', () => {
    projectDirSync = syncProjectDirFromRoots()
  })

  // Auto-track every tool invocation without touching each registration. Every tool waits
  // for a pending roots sync so its first call already runs in the agent's project.
  const originalRegisterTool = server.registerTool.bind(server)
  ;(server as unknown as { registerTool: typeof server.registerTool }).registerTool = (name: string, config: Parameters<typeof server.registerTool>[1], handler: Parameters<typeof server.registerTool>[2]) => {
    const tracked = withMcpToolTracking(String(name), async (...args: unknown[]) => (handler as (...args: unknown[]) => unknown)(...args))
    // Never leave the agent in a dead end: every error result (or throw) gets a way out appended.
    const waitForProjectDir = async (...args: unknown[]) => {
      await projectDirSync
      return runInProjectDir(async () => {
        const { projectDir, cwd, ...input } = (args[0] ?? {}) as { projectDir?: string, cwd?: string }
        const dir = await resolveProjectDirOptions({ projectDir, cwd }, selectedProjectDir)
        const isProjectDirSetter = name === 'capgo_set_project_dir'
        const baseDir = dir ?? selectedProjectDir
        const workingDir = isProjectDirSetter
          ? await resolveProjectDirInput(mcpSetProjectDirInputSchema.parse(input).path, baseDir)
          : baseDir
        if (projectDirError && !isProjectDirSetter && !dir)
          throw projectDirError
        return withCwd(workingDir, async () => {
          if (dir || isProjectDirSetter) {
            if (workingDir !== selectedProjectDir) {
              selectedProjectDir = workingDir
              refreshSdkForProject()
            }
            projectDirPinned = true
            projectDirError = undefined
          }
          return tracked(input, ...args.slice(1))
        })
      })
    }
    const guided = withErrorGuidance(String(name), waitForProjectDir)
    const contextFields = { projectDir: mcpProjectDirOptionSchema, cwd: mcpCwdOptionSchema }
    const inputSchema = config.inputSchema instanceof z.ZodObject
      ? config.inputSchema.safeExtend(contextFields)
      : z.object({ ...config.inputSchema, ...contextFields })
    return originalRegisterTool(name, { ...config, inputSchema } as unknown as typeof config, guided as typeof handler)
  }

  // Initialize the SDK from any saved key. Silent lookup (env -> ~/.capgo -> ./.capgo):
  // it never logs or throws when no key exists, so a no-key startup stays clean. The
  // throwing/logging findSavedKey() variant wrote a clack "please login" line to stdout,
  // which corrupted the handshake. capgo_login fills this in later without a restart.
  const savedApiKey = findSavedKeySilent()
  // `let` (not `const`): capgo_login/capgo_logout reassign this so the running session
  // re-authenticates without a restart. Tool handlers close over the binding, not the value.
  let sdk = new CapgoSDK({ apikey: savedApiKey })
  // On a project switch, drop the startup key so calls re-resolve credentials (env ->
  // ~/.capgo -> ./.capgo) from the new project, matching what capgo_whoami reports.
  function refreshSdkForProject(): void {
    sdk = new CapgoSDK({})
  }

  // Modern clients use explicit project selection instead of legacy roots.
  if (era === 'modern')
    projectDirSync = syncProjectDirFromRoots()

  server.registerTool(
    'capgo_set_project_dir',
    {
      description: 'Point the Capgo MCP at the project the agent is working in. Call this FIRST with the absolute Capacitor app path when the project or @capacitor/core appears missing. A workspace with one Capacitor app resolves automatically; multiple apps require selecting an app path. Check the project path before installing dependencies.',
      inputSchema: mcpSetProjectDirInputSchema,
    },
    async () => ({ content: [{ type: 'text' as const, text: describeProjectDir(selectedProjectDir) }] }),
  )

  // ============================================================================
  // Bundle Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_upload_bundle',
    {
      description: 'Package and upload a bundle from this local project to Capgo Cloud. Set delta=true to also upload the per-file manifest for delta updates.',
      inputSchema: mcpUploadBundleInputSchema,
    },
    async ({
      appId,
      path,
      mode,
      bundle,
      channel,
      rollout,
      rolloutPercentageBps,
      rolloutCacheTtlSeconds,
      comment,
      minUpdateVersion,
      autoMinUpdateVersion,
      autoSetBundle,
      autoBump,
      encrypt,
      acceptIncompatible,
      delta,
      deltaOnly,
      encryptDelta,
      apikey,
      capacitorConfig,
    }) => {
      const result = await sdk.uploadBundle({
        appId,
        path,
        mode,
        bundle,
        channel,
        rollout,
        rolloutPercentageBps,
        rolloutCacheTtlSeconds,
        comment,
        minUpdateVersion,
        autoMinUpdateVersion,
        autoSetBundle,
        autoBump,
        encrypt,
        acceptIncompatible,
        delta,
        deltaOnly,
        encryptDelta,
        apikey,
        capacitorConfig,
      })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Bundle uploaded successfully',
            bundleId: result.bundleId,
            checksum: result.checksum,
            skipped: result.skipped,
            reason: result.reason,
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'capgo_star_repository',
    {
      description: 'Use the locally authenticated GitHub CLI to star a repository to support Capgo',
      inputSchema: starRepoOptionsSchema,
    },
    async ({ repository }) => {
      const result = await sdk.starRepo({ repository })
      if (!result.success) {
        return formatMcpError(result)
      }

      const status = result.data?.alreadyStarred ? 'already starred' : 'starred successfully'
      return {
        content: [{
          type: 'text' as const,
          text: `Repository ${result.data?.repository} is ${status}.`,
        }],
      }
    },
  )

  server.registerTool(
    'capgo_star_all_repositories',
    {
      description: 'Use the locally authenticated GitHub CLI to star the default Capgo repositories with a random delay between requests',
      inputSchema: starAllRepositoriesOptionsSchema,
    },
    async ({ repositories, minDelayMs, maxDelayMs }) => {
      const result = await sdk.starAllRepositories({ repositories, minDelayMs, maxDelayMs })
      if (!result.success) {
        return formatMcpError(result)
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'capgo_check_compatibility',
    {
      description: 'Compare this project\'s local native dependencies with the bundle on a cloud channel',
      inputSchema: mcpCheckCompatibilityInputSchema,
    },
    async ({ appId, channel, packageJson }) => {
      const result = await sdk.checkBundleCompatibility({
        appId,
        channel,
        packageJson,
      })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      }
    },
  )

  // ============================================================================
  // Account & Diagnostics Tools
  // ============================================================================

  server.registerTool(
    'capgo_doctor',
    {
      description: 'Run diagnostics on the Capgo installation and get system information',
      inputSchema: mcpDoctorInputSchema,
    },
    async ({ packageJson }) => {
      const result = await sdk.doctor({ packageJson })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      }
    },
  )

  // ============================================================================
  // Build Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_request_build',
    {
      description: 'Package local project files and signing credentials, upload them, and request a native iOS/Android build from Capgo Cloud. Monitor the returned cloud job_id with the hosted MCP build tools.',
      inputSchema: mcpRequestBuildInputSchema,
    },
    async ({ appId, platform, path, nodeModules, useStoredCredentials, cache, cacheKey }) => {
      const result = await sdk.requestBuild({
        appId,
        platform,
        path,
        nodeModules,
        useStoredCredentials,
        cache,
        cacheKey,
        // Credentials come from the locally saved file and, with useStoredCredentials, from Capgo
      })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Build requested successfully',
            ...result.data,
          }, null, 2),
        }],
      }
    },
  )

  // ============================================================================
  // Encryption Key Tools
  // ============================================================================

  server.registerTool(
    'capgo_generate_encryption_keys',
    {
      description: 'Generate RSA key pair for end-to-end encryption of bundles',
      inputSchema: mcpGenerateEncryptionKeysInputSchema,
    },
    async ({ force, capacitorConfig }) => {
      const result = await sdk.generateEncryptionKeys({ force, capacitorConfig })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: 'Encryption keys generated successfully. Private key saved to .capgo_key_v2, public key to .capgo_key_v2.pub',
        }],
      }
    },
  )

  // ============================================================================
  // Probe Tool (no auth required - hits public /updates endpoint)
  // ============================================================================

  server.registerTool(
    'capgo_probe',
    {
      description: 'Probe the Capgo updates endpoint for a local project. Returns whether an OTA update would be delivered and diagnostic details if not. Does not require an API key.',
      inputSchema: mcpProbeInputSchema,
    },
    async ({ platform }) => {
      const result = await sdk.probe({ platform })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      }
    },
  )

  // ============================================================================
  // Authentication Tools
  // ============================================================================

  server.registerTool(
    'capgo_login',
    {
      description: 'Save an API key on this computer for the CLI and local MCP. Hosted MCP authorization is separate. Generate a key for your AI at https://console.capgo.app/connect, then call this with it. Authenticates the current MCP session immediately — no restart needed.',
      inputSchema: mcpLoginInputSchema,
    },
    async ({ apikey, scope }) => {
      try {
        const { userId } = await validateAndSaveKey(apikey, { local: scope === 'local' })
        // Re-init from call-time resolution (env → global → local) — the SAME source of
        // truth whoami/logout/onboarding use — so the SDK never authenticates as a
        // different identity than the one we report.
        sdk = new CapgoSDK({})
        let text = loginSuccessMessage(userId, scope === 'local')
        // If a higher-precedence credential overrides the key we just saved, say so:
        // tools will run as THAT credential, not the one just pasted.
        const active = await getLoginState()
        const savedSource = scope === 'local' ? 'local' : 'global'
        if (active.source && active.source !== savedSource)
          text += ` Note: a ${active.source} credential takes precedence over the ${savedSource} key you just saved, so tools will use it until it is removed.`
        return {
          content: [{ type: 'text' as const, text }],
        }
      }
      catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Login failed: ${formatError(error)}. Generate a fresh key at https://console.capgo.app/connect and try again.`,
          }],
          isError: true as const,
        }
      }
    },
  )

  server.registerTool(
    'capgo_whoami',
    {
      description: 'Inspect the CLI credentials on this computer: whether the local MCP is signed in, which user, and where the key is stored. Hosted MCP authorization is separate. Validates the saved key against Capgo.',
    },
    async () => {
      const state = await getLoginState({ validate: true })
      return { content: [{ type: 'text' as const, text: whoamiMessage(state) }] }
    },
  )

  server.registerTool(
    'capgo_logout',
    {
      description: 'Sign out by deleting the saved Capgo API key. Clears the global key (~/.capgo) by default, or the project-local key (./.capgo) with scope "local". Does not unset the CAPGO_TOKEN env var.',
      inputSchema: mcpLogoutInputSchema,
    },
    async ({ scope }) => {
      const { cleared } = await clearSavedKey({ local: scope === 'local' })
      // Drop the in-memory key so the main tools de-authenticate immediately.
      sdk = new CapgoSDK({})
      // Be honest: if a credential is still reachable (CAPGO_TOKEN, or the other
      // on-disk scope), say so rather than falsely claiming a full sign-out.
      const remaining = await getLoginState()
      return {
        content: [{ type: 'text' as const, text: logoutMessage(cleared, scope === 'local', remaining) }],
      }
    },
  )

  // MCP-conducted Builder onboarding (2-tool spine + explain). Build-time gated:
  // OFF in PR 1 while the flow was under construction, flipped ON in PR 2 now that
  // the full journey (android + iOS + tail) ships through the shared engine.
  // `bun run dev` keeps the flag undefined-safe; release builds define it to true.
  if (onboardingEnabled)
    registerOnboardingTools(server, () => sdk) // live accessor: honors capgo_login/logout reassignment

  // MCP-conducted live-update (OTA) onboarding (3-tool spine: start, next, explain).
  // Build-time gated: ships enabled in this release. The flag enables dead-code
  // elimination when the feature is disabled; release builds define it to true.
  if (liveUpdateEnabled)
    registerLiveUpdateTools(server, () => sdk) // live accessor: honors login/logout and project switches

  return server
}
