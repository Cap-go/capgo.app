import type { SDKResult } from '../schemas/sdk'
import process from 'node:process'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import pack from '../../package.json'
import { enableSupabaseInstrumentation, setInvocationSource, trackMcpServerStarted, withMcpToolTracking } from '../analytics/track'
import { parseSchema } from '../schemas/schema_validation'
import { starAllRepositoriesOptionsSchema, starRepoOptionsSchema, updateChannelOptionsSchema } from '../schemas/sdk'
import {
  mcpAddAppInputSchema,
  mcpAddChannelInputSchema,
  mcpAddOrganizationInputSchema,
  mcpCheckCompatibilityInputSchema,
  mcpCleanupBundlesInputSchema,
  mcpDeleteAppInputSchema,
  mcpDeleteBundleInputSchema,
  mcpDeleteChannelInputSchema,
  mcpDoctorInputSchema,
  mcpGenerateEncryptionKeysInputSchema,
  mcpGetCurrentBundleInputSchema,
  mcpGetStatsInputSchema,
  mcpListBundlesInputSchema,
  mcpListChannelsInputSchema,
  mcpProbeInputSchema,
  mcpRequestBuildInputSchema,
  mcpUpdateAppInputSchema,
  mcpUpdateChannelInputSchema,
  mcpUploadBundleInputSchema,
} from './tool-schemas'
import { CapgoSDK } from '../sdk'
import { getConfigWriteTarget, setConfigWriteTarget } from '../config'
import { clearSavedKey, getLoginState, loginSuccessMessage, logoutMessage, validateAndSaveKey, whoamiMessage } from '../auth/session'
import { mcpLoginInputSchema, mcpLogoutInputSchema } from '../schemas/auth'
import { findSavedKeySilent, formatError } from '../utils'
import { registerOnboardingTools } from '../build/onboarding/mcp/onboarding-tools'
import { registerLiveUpdateTools } from '../init/mcp/live-update-tools'
import { buildServerInstructions } from './instructions'
import { installMcpStdoutGuard } from './stdout-guard'

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
 * This allows AI agents to interact with Capgo Cloud programmatically.
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

  // Computed once: gates BOTH the onboarding-tool registration (below) and the
  // onboarding steer appended to the server instructions, so we never advertise a
  // start_capgo_builder_onboarding tool we didn't actually register.
  const onboardingEnabled = Boolean(globalThis.__CAPGO_MCP_ONBOARDING__)
  const liveUpdateEnabled = Boolean(globalThis.__CAPGO_MCP_LIVE_UPDATE__)
  const server = new McpServer(
    { name: 'capgo', version: pack.version },
    { instructions: buildServerInstructions({ onboardingEnabled, liveUpdateEnabled }) },
  )

  setInvocationSource('mcp')
  enableSupabaseInstrumentation()

  // Auto-track every tool invocation without touching each registration.
  const originalRegisterTool = server.registerTool.bind(server)
  ;(server as unknown as { registerTool: typeof server.registerTool }).registerTool = (name: string, config: Parameters<typeof server.registerTool>[1], handler: Parameters<typeof server.registerTool>[2]) => {
    return originalRegisterTool(name, config, withMcpToolTracking(String(name), handler as any) as typeof handler)
  }

  // Initialize the SDK from any saved key. Silent lookup (env -> ~/.capgo -> ./.capgo):
  // it never logs or throws when no key exists, so a no-key startup stays clean. The
  // throwing/logging findSavedKey() variant wrote a clack "please login" line to stdout,
  // which corrupted the handshake. capgo_login fills this in later without a restart.
  const savedApiKey = findSavedKeySilent()
  // `let` (not `const`): capgo_login/capgo_logout reassign this so the running session
  // re-authenticates without a restart. Tool handlers close over the binding, not the value.
  let sdk = new CapgoSDK({ apikey: savedApiKey })

  // ============================================================================
  // App Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_list_apps',
    {
      description: 'List all apps registered in your Capgo Cloud account',
    },
    async () => {
      const result = await sdk.listApps()
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
    'capgo_add_app',
    {
      description: 'Register a new app in Capgo Cloud',
      inputSchema: mcpAddAppInputSchema,
    },
    async ({ appId, name, icon }) => {
      const result = await sdk.addApp({ appId, name, icon })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully added app: ${appId}` }],
      }
    },
  )

  server.registerTool(
    'capgo_update_app',
    {
      description: 'Update settings for an existing app in Capgo Cloud',
      inputSchema: mcpUpdateAppInputSchema,
    },
    async ({ appId, name, icon, retention }) => {
      const result = await sdk.updateApp({ appId, name, icon, retention })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully updated app: ${appId}` }],
      }
    },
  )

  server.registerTool(
    'capgo_delete_app',
    {
      description: 'Delete an app from Capgo Cloud',
      inputSchema: mcpDeleteAppInputSchema,
    },
    async ({ appId }) => {
      const result = await sdk.deleteApp(appId, true) // skipConfirmation=true for non-interactive
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully deleted app: ${appId}` }],
      }
    },
  )

  // ============================================================================
  // Bundle Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_upload_bundle',
    {
      description: 'Upload a new app bundle to Capgo Cloud for distribution',
      inputSchema: mcpUploadBundleInputSchema,
    },
    async ({
      appId,
      path,
      bundle,
      channel,
      rollout,
      rolloutPercentageBps,
      rolloutCacheTtlSeconds,
      comment,
      minUpdateVersion,
      autoMinUpdateVersion,
      autoSetBundle,
      encrypt,
      capacitorConfig,
    }) => {
      const result = await sdk.uploadBundle({
        appId,
        path,
        bundle,
        channel,
        rollout,
        rolloutPercentageBps,
        rolloutCacheTtlSeconds,
        comment,
        minUpdateVersion,
        autoMinUpdateVersion,
        autoSetBundle,
        encrypt,
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
      description: 'Star a GitHub repository to support Capgo',
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
      description: 'Star the default Capgo repositories on GitHub with a random delay between requests',
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
    'capgo_list_bundles',
    {
      description: 'List all bundles uploaded for an app',
      inputSchema: mcpListBundlesInputSchema,
    },
    async ({ appId }) => {
      const result = await sdk.listBundles(appId)
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
    'capgo_delete_bundle',
    {
      description: 'Delete a specific bundle from Capgo Cloud',
      inputSchema: mcpDeleteBundleInputSchema,
    },
    async ({ appId, bundleId }) => {
      const result = await sdk.deleteBundle(appId, bundleId)
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully deleted bundle: ${bundleId}` }],
      }
    },
  )

  server.registerTool(
    'capgo_cleanup_bundles',
    {
      description: 'Delete old bundles, keeping only recent versions',
      inputSchema: mcpCleanupBundlesInputSchema,
    },
    async ({ appId, keep, bundle, force, ignoreChannel }) => {
      const result = await sdk.cleanupBundles({
        appId,
        keep,
        bundle,
        force: force ?? true, // Default to true for non-interactive
        ignoreChannel,
      })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Cleanup completed',
            removed: result.data?.removed,
            kept: result.data?.kept,
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'capgo_check_compatibility',
    {
      description: 'Check bundle compatibility with a specific channel',
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
  // Channel Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_list_channels',
    {
      description: 'List all channels for an app',
      inputSchema: mcpListChannelsInputSchema,
    },
    async ({ appId }) => {
      const result = await sdk.listChannels(appId)
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
    'capgo_add_channel',
    {
      description: 'Create a new distribution channel for an app',
      inputSchema: mcpAddChannelInputSchema,
    },
    async ({ appId, channelId, default: isDefault, selfAssign }) => {
      const result = await sdk.addChannel({
        appId,
        channelId,
        default: isDefault,
        selfAssign,
      })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully created channel: ${channelId}` }],
      }
    },
  )

  server.registerTool(
    'capgo_update_channel',
    {
      description: 'Update channel settings including linked bundle and targeting options',
      inputSchema: mcpUpdateChannelInputSchema,
    },
    async ({ appId, channelId, bundle, state, downgrade, ios, android, selfAssign, disableAutoUpdate, dev, emulator, device, prod, rolloutBundle, rolloutPercentage, rolloutPercentageBps, rolloutEnable, rolloutDisable, rolloutPause, rolloutResume, rolloutRollback, rolloutPromote, rolloutCacheTtlSeconds, autoPauseEnabled, autoPauseDisabled, autoPauseWindowMinutes, autoPauseFailureRateBps, autoPauseConfidence, autoPauseMinAttempts, autoPauseMinFailures, autoPauseAction, autoPauseCooldownMinutes }) => {
      const payload = parseSchema(updateChannelOptionsSchema, {
        appId,
        channelId,
        bundle,
        state,
        downgrade,
        ios,
        android,
        selfAssign,
        disableAutoUpdate,
        dev,
        emulator,
        device,
        prod,
        rolloutBundle,
        rolloutPercentage,
        rolloutPercentageBps,
        rolloutEnable,
        rolloutDisable,
        rolloutPause,
        rolloutResume,
        rolloutRollback,
        rolloutPromote,
        rolloutCacheTtlSeconds,
        autoPauseEnabled,
        autoPauseDisabled,
        autoPauseWindowMinutes,
        autoPauseFailureRateBps,
        autoPauseConfidence,
        autoPauseMinAttempts,
        autoPauseMinFailures,
        autoPauseAction,
        autoPauseCooldownMinutes,
      })
      const result = await sdk.updateChannel(payload)
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully updated channel: ${channelId}` }],
      }
    },
  )

  server.registerTool(
    'capgo_delete_channel',
    {
      description: 'Delete a channel from an app',
      inputSchema: mcpDeleteChannelInputSchema,
    },
    async ({ appId, channelId, deleteBundle }) => {
      const result = await sdk.deleteChannel(channelId, appId, deleteBundle)
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{ type: 'text' as const, text: `Successfully deleted channel: ${channelId}` }],
      }
    },
  )

  server.registerTool(
    'capgo_get_current_bundle',
    {
      description: 'Get the current bundle linked to a specific channel',
      inputSchema: mcpGetCurrentBundleInputSchema,
    },
    async ({ appId, channelId }) => {
      const result = await sdk.getCurrentBundle(appId, channelId)
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ channel: channelId, currentBundle: result.data }, null, 2),
        }],
      }
    },
  )

  // ============================================================================
  // Organization Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_list_organizations',
    {
      description: 'List all organizations you have access to',
    },
    async () => {
      const result = await sdk.listOrganizations()
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
    'capgo_add_organization',
    {
      description: 'Create a new organization for team collaboration',
      inputSchema: mcpAddOrganizationInputSchema,
    },
    async ({ name, email }) => {
      const result = await sdk.addOrganization({ name, email })
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Organization created successfully',
            ...result.data,
          }, null, 2),
        }],
      }
    },
  )

  // ============================================================================
  // Account & Diagnostics Tools
  // ============================================================================

  server.registerTool(
    'capgo_get_account_id',
    {
      description: 'Get the account ID associated with the current API key',
    },
    async () => {
      const result = await sdk.getAccountId()
      if (!result.success) {
        return formatMcpError(result)
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ accountId: result.data }, null, 2),
        }],
      }
    },
  )

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

  server.registerTool(
    'capgo_get_stats',
    {
      description: 'Get device statistics and logs from Capgo backend for debugging',
      inputSchema: mcpGetStatsInputSchema,
    },
    async ({ appId, deviceIds, limit, rangeStart, rangeEnd }) => {
      const result = await sdk.getStats({
        appId,
        deviceIds,
        limit,
        rangeStart,
        rangeEnd,
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
  // Build Management Tools
  // ============================================================================

  server.registerTool(
    'capgo_request_build',
    {
      description: 'Request a native iOS/Android build from Capgo Cloud',
      inputSchema: mcpRequestBuildInputSchema,
    },
    async ({ appId, platform, path, nodeModules }) => {
      const result = await sdk.requestBuild({
        appId,
        platform,
        path,
        nodeModules,
        // Credentials should be pre-saved using the CLI
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
      description: 'Sign in to Capgo by saving an API key. Generate a key for your AI at https://console.capgo.app/connect, then call this with it. Authenticates the current MCP session immediately — no restart needed.',
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
      description: 'Report whether the Capgo MCP is signed in, and if so which user and where the key is stored. Validates the saved key against Capgo.',
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
    registerLiveUpdateTools(server, sdk)

  // Start the server with stdio transport. The stdout guard installed at the top of this
  // function already routed ambient stdout (stray clack/console output from any tool or
  // dependency) to stderr, so only JSON-RPC frames reach the real stdout a strict client
  // reads; otherwise the transport drops ("Transport closed"). Keep the config target
  // for this server's lifetime because tool calls happen after the CLI action completes.
  const transport = new StdioServerTransport(process.stdin, transportStdout)
  transport.onclose = restoreConfigWriteTarget
  await server.connect(transport)
  trackMcpServerStarted(Boolean(savedApiKey))
}
