import process from 'node:process'
// src/init/mcp/live-update-tools.ts
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { CapgoSDK } from '../../sdk.js'
import type { LiveUpdateNextStepInput, LiveUpdateStartInput } from '../../schemas/live-update-onboarding.js'
import { liveUpdateExplainInputSchema, liveUpdateNextStepSchema, liveUpdateStartSchema } from '../../schemas/live-update-onboarding.js'
import type { McpRegistrar } from '../../mcp/registrar.js'
import { getConfigWriteTarget, resolveCapacitorConfigTargetPath, withConfigWriteTarget } from '../../config'
import { getPlatformDirFromCapacitorConfig } from '../../build/platform-paths.js'
import { createKeyInternal } from '../../key.js'
import { isAppAlreadyExistsError } from '../app-conflict.js'
import {
  applyInitAutoTestChange,
  getGitRepoStatus,
  getInitSuggestedOtaVersion,
  getInitUpdaterPluginConfig,
  resolveInitTargetPath,
} from '../command.js'
import { getUpdaterInstallState } from '../updater.js'
import { baseKeyV2, findSavedKeySilent, findMainFile, findRoot, getAppId, getBundleVersion, getConfig, getPMAndCommand, PACKNAME, updateConfigUpdater } from '../../utils.js'
import { formatRunnerCommand } from '../../runner-command.js'
import { addChannelInternal } from '../../channel/add.js'
import { uploadBundleInternal } from '../../bundle/upload.js'
import { execSync, spawnSync } from 'node:child_process'
import type { NextStepResult, Platform } from './contract.js'
import { renderResult } from './contract.js'
import type { EngineDeps } from './engine.js'
import { explainLiveUpdateOnboarding, runAdvance, runStart } from './engine.js'
import { clearLiveUpdateProgress, loadLiveUpdateProgress, saveLiveUpdateProgress } from './progress.js'



const DEFAULT_CHANNEL = 'production'
const importInject = 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\''
const codeInject = 'CapacitorUpdater.notifyAppReady()'

export interface LiveUpdateProjectTarget {
  packageJsonPath?: string
  mainFilePath?: string
}

type LiveUpdateProjectTargetInput = Pick<LiveUpdateStartInput, 'packageJson' | 'mainFile'>

function hasProjectTarget(target: LiveUpdateProjectTarget | undefined): target is LiveUpdateProjectTarget {
  return Boolean(target?.packageJsonPath || target?.mainFilePath)
}

export function resolveLiveUpdateProjectTarget(input: LiveUpdateProjectTargetInput, initialCwd = process.cwd()): LiveUpdateProjectTarget {
  const packageJsonPath = resolveInitTargetPath(input.packageJson, 'Package JSON path', initialCwd)
  if (packageJsonPath && basename(packageJsonPath) !== PACKNAME)
    throw new Error(`Package JSON path must point to ${PACKNAME}: ${packageJsonPath}`)

  const mainFilePath = resolveInitTargetPath(input.mainFile, 'Main file path', initialCwd)
  if (mainFilePath && !/\.[cm]?[jt]sx?$/.test(mainFilePath))
    throw new Error(`Main file path must point to a JavaScript or TypeScript file: ${mainFilePath}`)

  return { packageJsonPath, mainFilePath }
}

function getRunDeviceCommandForPlatform(platform: Platform, projectDir: string, initialCwd: string): { command: string, cwd?: string } {
  const pm = getPMAndCommand()
  const args = ['cap', 'run', platform]
  const command = formatRunnerCommand(pm.runner, args)
  return { command, ...(projectDir === initialCwd ? {} : { cwd: projectDir }) }
}

export function buildDeps(
  sdk: CapgoSDK,
  cwd = process.cwd(),
  getProjectTarget: () => LiveUpdateProjectTarget | undefined = () => undefined,
): EngineDeps {
  const getPackageJsonPath = () => getProjectTarget()?.packageJsonPath ?? join(findRoot(cwd), PACKNAME)
  const getProjectDir = () => dirname(getPackageJsonPath())
  const getMainFile = async () => getProjectTarget()?.mainFilePath ?? findMainFile(true, getProjectDir())
  const getNodeModulesPath = () => {
    const nodeModulesPath = join(findRoot(getProjectDir()), 'node_modules')
    return existsSync(nodeModulesPath) ? nodeModulesPath : undefined
  }
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
        const projectDir = getProjectDir()
        const iosDir = getPlatformDirFromCapacitorConfig(ext?.config, 'ios')
        const androidDir = getPlatformDirFromCapacitorConfig(ext?.config, 'android')
        if (existsSync(join(projectDir, iosDir)))
          out.push('ios')
        if (existsSync(join(projectDir, androidDir)))
          out.push('android')
      }
      catch {
        // not a capacitor project
      }
      return out
    },
    isAppRegistered: async (appId: string) => {
      const res = await sdk.appHasAccess(appId)
      return res.success && res.data === true
    },
    loadProgress: () => loadLiveUpdateProgress(),
    saveProgress: data => saveLiveUpdateProgress(data),
    clearProgress: () => clearLiveUpdateProgress(),
    registerApp: async (appId: string) => {
      const res = await sdk.addApp({ appId })
      if (res.success)
        return { ok: true as const }
      const error = res.error || 'Failed to register app'
      return { ok: false as const, alreadyExists: isAppAlreadyExistsError(error), error }
    },
    ensureChannel: async (appId: string, channelName: string) => {
      try {
        const apikey = findSavedKeySilent() ?? ''
        await addChannelInternal(channelName, appId, { default: true, apikey }, true)
        return { ok: true as const }
      }
      catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    installUpdater: async (appId: string) => {
      try {
        const packageJsonPath = getPackageJsonPath()
        const projectDir = getProjectDir()
        const installState = getUpdaterInstallState(packageJsonPath)
        if (!installState.ready) {
          const pm = getPMAndCommand()
          const install = spawnSync(pm.pm, ['add', '@capgo/capacitor-updater@latest'], { cwd: projectDir, stdio: 'pipe' })
          if (install.status !== 0)
            throw new Error(install.stderr?.toString() || 'Package install failed')
        }
        const delta = false
        await updateConfigUpdater(getInitUpdaterPluginConfig(appId, delta))
        const currentVersion = getBundleVersion(undefined, packageJsonPath) || '1.0.0'
        return { ok: true as const, delta, currentVersion }
      }
      catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    addIntegrationCode: async (_appId: string) => {
      try {
        const mainFile = await getMainFile()
        if (!mainFile)
          return { ok: false as const, error: 'Could not find main entry file' }
        let content = await readFile(mainFile, 'utf8')
        if (!content.includes(codeInject)) {
          if (!content.includes('CapacitorUpdater'))
            content = `${importInject}\n${content}`
          if (content.includes('function App('))
            content = content.replace(/function App\(/, `${codeInject}\n\nfunction App(`)
          else
            content = `${content.trimEnd()}\n${codeInject}\n`
          await writeFile(mainFile, content, 'utf8')
        }
        return { ok: true as const }
      }
      catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    setupEncryption: async (_appId: string, enable: boolean) => {
      if (!enable)
        return { ok: true as const, enabled: false }
      try {
        await createKeyInternal({ force: false, keyDir: getProjectDir(), setupChannel: false }, true)
        return { ok: true as const, enabled: true }
      }
      catch (error) {
        return { ok: false as const, enabled: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    buildProject: async (_appId: string, platform: Platform) => {
      try {
        const pm = getPMAndCommand()
        const projectDir = getProjectDir()
        execSync(`${pm.pm} run build`, { cwd: projectDir, stdio: 'pipe' })
        execSync(formatRunnerCommand(pm.runner, ['cap', 'sync', platform]), { cwd: projectDir, stdio: 'pipe' })
        return { ok: true as const }
      }
      catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    applyTestChange: async (_appId: string, baseVersion?: string) => {
      try {
        const packageJsonPath = getPackageJsonPath()
        const mainFile = await getMainFile()
        if (!mainFile)
          return { ok: false as const, error: 'Could not find main entry file for test change' }
        const content = await readFile(mainFile, 'utf8')
        const changed = applyInitAutoTestChange(mainFile, content)
        if (changed)
          await writeFile(mainFile, changed.content, 'utf8')
        const version = getInitSuggestedOtaVersion(baseVersion || getBundleVersion(undefined, packageJsonPath) || '1.0.0')
        return { ok: true as const, version }
      }
      catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    uploadBundle: async (appId: string, opts) => {
      try {
        const projectDir = getProjectDir()
        const packageJsonPath = getPackageJsonPath()
        const privateKeyPath = join(projectDir, baseKeyV2)
        const encrypt = opts.encrypt === true
        if (encrypt && !existsSync(privateKeyPath))
          return { ok: false as const, error: `Cannot find private key ${privateKeyPath}` }

        const webDir = (await getConfig(true))?.config.webDir
        const apikey = findSavedKeySilent() ?? ''
        await uploadBundleInternal(appId, {
          apikey,
          bundle: opts.version,
          channel: opts.channelName || DEFAULT_CHANNEL,
          deltaOnly: opts.delta,
          ignoreChecksumCheck: true,
          key: encrypt ? undefined : false,
          keyV2: encrypt ? privateKeyPath : undefined,
          nodeModules: getNodeModulesPath(),
          packageJson: packageJsonPath,
          path: webDir ? resolve(projectDir, webDir) : undefined,
          showReplicationProgress: false,
        }, true)
        return { ok: true as const }
      }
      catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },

    getRunDeviceCommand: platform => getRunDeviceCommandForPlatform(platform, getProjectDir(), cwd),
    getGitStatus: startDir => getGitRepoStatus(startDir ?? getProjectDir()),
  }
}

function addConfigTargetToResult(
  result: NextStepResult,
  configTarget: string | undefined,
  projectTarget: LiveUpdateProjectTarget | undefined,
): NextStepResult {
  const targetArgs = {
    ...(configTarget ? { capacitorConfig: configTarget } : {}),
    ...(projectTarget?.packageJsonPath ? { packageJson: projectTarget.packageJsonPath } : {}),
    ...(projectTarget?.mainFilePath ? { mainFile: projectTarget.mainFilePath } : {}),
  }
  const targetNames = Object.keys(targetArgs)
  if (targetNames.length === 0)
    return result

  const context = { ...result.context, ...targetArgs }
  if (!result.next)
    return { ...result, context }

  const withArgs = { ...result.next.with, ...targetArgs }
  return {
    ...result,
    context,
    next: {
      ...result.next,
      with: withArgs,
      call: `${result.next.tool}(${JSON.stringify(withArgs)})`,
      instruction: `${result.next.instruction} Include the same ${targetNames.join(', ')} from context.`,
    },
  }
}

export function registerLiveUpdateTools(server: McpRegistrar, sdk: CapgoSDK, depsOverride?: EngineDeps): void {
  const configTargetsByApp = new Map<string, Set<string>>()
  const projectTargetsByConfig = new Map<string, LiveUpdateProjectTarget>()
  const deps = depsOverride ?? buildDeps(sdk, process.cwd(), () => {
    const configTarget = getConfigWriteTarget()
    return configTarget ? projectTargetsByConfig.get(configTarget) : undefined
  })
  const addConfigTarget = (appId: string, configTarget: string): void => {
    const targets = configTargetsByApp.get(appId) ?? new Set<string>()
    targets.add(configTarget)
    configTargetsByApp.set(appId, targets)
  }
  const removeConfigTarget = (appId: string, configTarget: string): void => {
    const targets = configTargetsByApp.get(appId)
    if (!targets)
      return
    targets.delete(configTarget)
    if (targets.size === 0)
      configTargetsByApp.delete(appId)
  }
  const getSessionProjectTarget = (
    configTarget: string | undefined,
    incomingTarget: LiveUpdateProjectTarget,
  ): LiveUpdateProjectTarget | undefined => {
    if (!configTarget)
      return hasProjectTarget(incomingTarget) ? incomingTarget : undefined

    const currentTarget = projectTargetsByConfig.get(configTarget)
    if (!hasProjectTarget(incomingTarget))
      return currentTarget
    if (
      (currentTarget?.packageJsonPath && incomingTarget.packageJsonPath && currentTarget.packageJsonPath !== incomingTarget.packageJsonPath)
      || (currentTarget?.mainFilePath && incomingTarget.mainFilePath && currentTarget.mainFilePath !== incomingTarget.mainFilePath)
    ) {
      throw new Error('This onboarding already has packageJson or mainFile targets for its Capacitor config. Pass the same paths from context.')
    }

    const projectTarget = { ...currentTarget, ...incomingTarget }
    projectTargetsByConfig.set(configTarget, projectTarget)
    return projectTarget
  }
  const updateActiveConfigTarget = (appId: string | undefined, configTarget: string | undefined, result: NextStepResult): void => {
    if (configTarget && result.kind === 'done')
      projectTargetsByConfig.delete(configTarget)
    if (!appId || !configTarget)
      return
    if (result.kind === 'done')
      removeConfigTarget(appId, configTarget)
    else
      addConfigTarget(appId, configTarget)
  }
  const migrateLegacyProgress = (appId: string | undefined, configTarget: string): void => {
    const legacyProgress = withConfigWriteTarget(undefined, () => deps.loadProgress())
    if (!legacyProgress || (legacyProgress.appId && legacyProgress.appId !== appId))
      return

    const targetProgress = withConfigWriteTarget(configTarget, () => deps.loadProgress())
    if (targetProgress)
      return

    withConfigWriteTarget(configTarget, () => deps.saveProgress(legacyProgress))
    withConfigWriteTarget(undefined, () => deps.clearProgress())
  }
  const getSessionConfigTarget = async (capacitorConfig?: string): Promise<string | undefined> => {
    if (capacitorConfig !== undefined)
      return resolveCapacitorConfigTargetPath(capacitorConfig, deps.cwd)

    const appId = await deps.getAppId()
    const targets = appId ? configTargetsByApp.get(appId) : undefined
    if (targets && targets.size > 1) {
      throw new Error('Multiple Capacitor config sources are active for this onboarding. Pass the same capacitorConfig path used to start this flow.')
    }
    return targets?.values().next().value ?? getConfigWriteTarget()
  }

  server.registerTool(
    'start_capgo_live_update_onboarding',
    {
      description: 'Start (or resume) the guided Capgo live-update (OTA) setup for this Capacitor project — register the app, install the updater plugin, build, upload a test bundle, and confirm OTA delivery. ALWAYS call this FIRST when the user wants to set up or troubleshoot Capgo OTA / live updates. Do NOT configure Capgo yourself — this tool conducts the flow.',
      inputSchema: liveUpdateStartSchema,
    },
    async (args: LiveUpdateStartInput) => {
      const requestedProjectTarget = resolveLiveUpdateProjectTarget(args, deps.cwd)
      const requestedConfigTarget = args.capacitorConfig === undefined
        ? getConfigWriteTarget()
        : resolveCapacitorConfigTargetPath(args.capacitorConfig, deps.cwd)
      const { appId, result, configTarget, projectTarget } = await withConfigWriteTarget(requestedConfigTarget, async () => {
        let configTarget = requestedConfigTarget
        if (!configTarget) {
          try {
            configTarget = (await getConfig(true)).path
          }
          catch {
            // runStart returns the normal no-Capacitor-project response
          }
        }
        const projectTarget = getSessionProjectTarget(configTarget, requestedProjectTarget)
        const appId = await deps.getAppId()
        if (configTarget)
          migrateLegacyProgress(appId, configTarget)
        const result = await withConfigWriteTarget(configTarget, () => runStart(deps))
        return { appId, result, configTarget, projectTarget }
      })
      updateActiveConfigTarget(appId, configTarget, result)
      return { content: [{ type: 'text' as const, text: renderResult(addConfigTargetToResult(result, configTarget, projectTarget)) }] }
    },
  )

  server.registerTool(
    'capgo_live_update_onboarding_next_step',
    {
      description: 'Advance the guided Capgo live-update onboarding by one step. Call ONLY as directed by the previous result\'s `next`. Pass the user\'s choice when the previous step asked for one.',
      inputSchema: liveUpdateNextStepSchema,
    },
    async (args: LiveUpdateNextStepInput) => {
      const { capacitorConfig, packageJson, mainFile, ...input } = args
      const configTarget = await getSessionConfigTarget(capacitorConfig)
      const projectTarget = getSessionProjectTarget(configTarget, resolveLiveUpdateProjectTarget({ packageJson, mainFile }, deps.cwd))
      const { appId, result } = await withConfigWriteTarget(configTarget, async () => ({
        appId: await deps.getAppId(),
        result: await runAdvance(deps, input),
      }))
      updateActiveConfigTarget(appId, configTarget, result)
      return { content: [{ type: 'text' as const, text: renderResult(addConfigTargetToResult(result, configTarget, projectTarget)) }] }
    },
  )

  server.registerTool(
    'capgo_live_update_onboarding_explain',
    {
      description: 'Explain a Capgo live-update onboarding step in plain language — call when the user is confused. Defaults to the CURRENT step; pass { state } for a specific one. Read-only; never advances the flow.',
      inputSchema: liveUpdateExplainInputSchema,
    },
    async (args: { state?: string, capacitorConfig?: string }) => {
      const { capacitorConfig, ...input } = args
      const configTarget = await getSessionConfigTarget(capacitorConfig)
      const text = await withConfigWriteTarget(configTarget, () => explainLiveUpdateOnboarding(deps, input))
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  server.registerPrompt(
    'capgo-live-update-setup',
    { description: 'Set up Capgo live updates (OTA) for this Capacitor app — starts the guided onboarding.' },
    () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Set up Capgo live updates (OTA) in this project. Call start_capgo_live_update_onboarding now, then follow each result\'s `next` field — using capgo_live_update_onboarding_next_step and capgo_live_update_onboarding_explain exactly as directed — until setup is complete. Do NOT configure Capgo manually.',
        },
      }],
    }),
  )
}
