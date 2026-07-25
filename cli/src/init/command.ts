import type { Buffer } from 'node:buffer'
import type { ExistingOrganizationApp, Options, PendingOnboardingApp } from '../api/app'
import type { Organization } from '../utils'
import type { InitCodeDiff, InitEncryptionPhase, InitEncryptionSummary } from './runtime'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path, { dirname, join } from 'node:path'
import { chdir, cwd, env, exit, platform, stderr, stdin, stdout } from 'node:process'
import { canParse, format, increment, lessThan, parse } from '@std/semver'
import open from 'open'
import tmp from 'tmp'
import { checkAppIdsExist, completePendingOnboardingApp, findAppInOrganization, listPendingOnboardingApps } from '../api/app'
import { checkVersionStatus } from '../api/update'
import { addAppInternal } from '../app/add'
import { markSnag, waitLog } from '../app/debug'
import { deleteAppInternal } from '../app/delete'
import { getInfoInternal } from '../app/info'
import { canUseFilePicker, openPackageJsonPicker } from '../build/onboarding/file-picker'
import { getPlatformDirFromCapacitorConfig } from '../build/platform-paths'
import { uploadBundleInternal } from '../bundle/upload'
import { addChannelInternal } from '../channel/add'
import { getConfigWriteTarget, resolveCapacitorConfigTargetPath, setConfigWriteTarget, writeConfigUpdater } from '../config'
import { getRepoStarStatus, isRepoStarredInSession, starAllRepositories, starRepository } from '../github'
import { createKeyInternal } from '../key'
import { doLoginExists, loginInternal } from '../login'
import { writeOnboardingSupportBundle, writeSupportBundleFiles } from '../onboarding-support'
import { showReplicationProgress } from '../replicationProgress'
import { formatRunnerCommand, splitRunnerCommand } from '../runner-command'
import { copyToClipboard, revealInFinder } from '../support/clipboard'
import { contactSupport } from '../support/contact-support'
import { appendInternalLog, getInternalLogPath, startInternalLog } from '../support/internal-log'
import { uploadSupportLogs } from '../support/support-upload'
import { consoleWebUrl, createSupabaseClient, defaultApiHost, findBuildCommandForProjectType, findMainFile, findMainFileForProjectType, findProjectType, findRoot, findSavedKey, findSavedKeySilent, formatError, getAllPackagesDependencies, getAppId, getBundleVersion, getConfig, getConfigForWrite, getLocalConfig, getNativeProjectResetAdvice, getOrganizationListWithPermission, getPackageScripts, getPMAndCommand, hasCliPermission, PACKNAME, projectIsMonorepo, resolveUserIdFromApiKey, updateConfigbyKey, updateConfigUpdater, validateIosUpdaterSync } from '../utils'
import { buildAppIdConflictSuggestions, isAppAlreadyExistsError } from './app-conflict'
import { cancel as pCancel, confirm as pConfirm, intro as pIntro, isCancel as pIsCancel, log as pLog, outro as pOutro, select as pSelect, spinner as pSpinner, text as pText } from './prompts'
import { finishActiveCliReplay, getActiveCliReplaySessionId, isCliTelemetryDisabled, startInitReplay } from './replay'
import { appendInitStreamingLine, clearInitStreamingOutput, setInitCodeDiff, setInitEncryptionSummary, setInitVersionWarning, startInitStreamingOutput, stopInitInkSession, updateInitStreamingStatus } from './runtime'
import { formatInitResumeMessage, initOnboardingSteps, renderInitOnboardingComplete, renderInitOnboardingFrame, renderInitOnboardingWelcome } from './ui'
import { CAPGO_UPDATER_PACKAGE, getUpdaterInstallState } from './updater'

interface SuperOptions extends Options {
  analytics?: boolean
  capacitorConfig?: string
  local: boolean
  mainFile?: string
  packageJson?: string
}

interface InitTargetPaths {
  pathToPackageJson?: string
  capacitorConfigPath?: string
  configLoadDir?: string
  mainFilePath?: string
}

export type RunDeviceCancelHandler = () => Promise<never>
const importInject = 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\''
const codeInject = 'CapacitorUpdater.notifyAppReady()'
// create regex to find line who start by 'import ' and end by ' from '
const regexImport = /import.*from.*/g
const defaultChannel = 'production'
const channelNameRegex = /^[\w.-]+$/
const appIdRegex = /^[a-z0-9]+(?:\.[\w-]+)+$/i
const whitespaceSplitPattern = /\s+/
const capacitorConfigFiles = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json']
const capacitorGettingStartedUrl = 'https://capacitorjs.com/docs/getting-started'
const nextWebDirPattern = /["']?webDir["']?\s*:\s*["']out["']/
const nuxtWebDirPattern = /["']?webDir["']?\s*:\s*["']\.output\/public["']/
const initNativeBundleVersion = '0.0.0'
const temporaryTestBannerText = '🚀 Capgo Update Test - Temporary test banner, remove it after validating the update worked.'
const htmlAutoTestInjection = `  <div id="capgo-test-banner" style="background: linear-gradient(90deg, #4CAF50, #2196F3); color: white; padding: 15px; text-align: center; font-weight: bold; position: fixed; top: env(safe-area-inset-top, 0); left: env(safe-area-inset-left, 0); right: env(safe-area-inset-right, 0); z-index: 9999; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding-top: calc(15px + env(safe-area-inset-top, 0));">
    ${temporaryTestBannerText}
  </div>
  <style>
    body { padding-top: calc(60px + env(safe-area-inset-top, 0)) !important; }
  </style>`
const vueAutoTestInjection = `  <div class="capgo-test-vue" style="background: linear-gradient(90deg, #4CAF50, #2196F3); color: white; padding: 15px; text-align: center; font-weight: bold; margin-bottom: 20px; padding-top: calc(15px + env(safe-area-inset-top, 0)); padding-left: calc(15px + env(safe-area-inset-left, 0)); padding-right: calc(15px + env(safe-area-inset-right, 0));">
    ${temporaryTestBannerText}
  </div>`
const cssAutoTestInjection = `/* Capgo test modification - background change */
body {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
  /* capgo-test-background */
}

`
async function exitAfterFinishingReplay(code?: number): Promise<never> {
  await finishActiveCliReplay()
  exit(code)
  throw new Error('process.exit returned unexpectedly')
}
const frameworkSetupGuides = {
  nextjs: 'https://capgo.app/blog/nextjs-mobile-app-capacitor-from-scratch/',
  nuxtjs: 'https://capgo.app/blog/nuxt-mobile-app-capacitor-from-scratch/',
  sveltekit: 'https://capgo.app/blog/creating-mobile-apps-with-sveltekit-and-capacitor/',
} as const
type CapacitorConfigSnapshot = Awaited<ReturnType<typeof getConfig>>['config']
type CancelablePromptValue = boolean | string | symbol
type InitAutoTestChangeKind = 'html-banner' | 'vue-banner' | 'css-background'
type DirtyGitStatusAction = 'check-again' | 'continue-dirty'

interface GitRepoStatus {
  inRepo: boolean
  clean: boolean
  repoRoot?: string
  entries: string[]
  error?: string
}

interface InitAutoTestChange {
  filePath: string
  displayPath: string
  kind: InitAutoTestChangeKind
}
let globalCapacitorConfigPath: string | undefined
let globalConfigLoadDir: string | undefined
let globalMainFilePath: string | undefined

let tmpObject: tmp.FileResult['name'] | undefined
let globalPathToPackageJson: string | undefined
let globalNodeModulesPath: string | undefined
let globalChannelName = defaultChannel
let globalPlatform: 'ios' | 'android' = 'ios'
let globalDelta = false
let globalCurrentVersion: string | undefined
let globalAppId: string | undefined
let globalSupaHost: string | undefined

export function resolveInitTargetPath(value: string | undefined, label: string, initialCwd = cwd()): string | undefined {
  if (!value)
    return undefined

  const resolved = path.resolve(initialCwd, value)
  if (!existsSync(resolved) || !statSync(resolved).isFile())
    throw new Error(`${label} does not exist: ${resolved}`)

  const workspaceRoot = realpathSync(initialCwd)
  const target = realpathSync(resolved)
  const pathFromWorkspace = path.relative(workspaceRoot, target)
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(pathFromWorkspace))
    throw new Error(`${label} must stay within the current working directory: ${resolved}`)
  return resolved
}

function resolveInitDirectoryPath(value: string | undefined, initialCwd: string): string | undefined {
  if (!value)
    return undefined

  const resolved = path.resolve(initialCwd, value)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory())
    return undefined

  const workspaceRoot = realpathSync(initialCwd)
  const target = realpathSync(resolved)
  const pathFromWorkspace = path.relative(workspaceRoot, target)
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(pathFromWorkspace))
    return undefined
  return resolved
}

export function resolveResumedInitTargets(currentTargets: InitTargetPaths, savedTargets: Partial<InitTargetPaths>, initialCwd = cwd()): InitTargetPaths | undefined {
  // An explicit config source identifies the app being onboarded. Never merge
  // it with a checkpoint created for another app in the same workspace.
  if (currentTargets.capacitorConfigPath) {
    try {
      const currentConfigPath = resolveCapacitorConfigTargetPath(currentTargets.capacitorConfigPath, initialCwd)
      const savedConfigPath = savedTargets.capacitorConfigPath
        ? resolveCapacitorConfigTargetPath(savedTargets.capacitorConfigPath, initialCwd)
        : undefined
      if (!currentConfigPath || currentConfigPath !== savedConfigPath)
        return undefined
    }
    catch {
      return undefined
    }
  }

  const resumedTargets = { ...currentTargets }

  if (!resumedTargets.pathToPackageJson && savedTargets.pathToPackageJson) {
    try {
      const packageJsonPath = resolveInitTargetPath(savedTargets.pathToPackageJson, 'Package JSON path', initialCwd)
      if (!packageJsonPath)
        return undefined
      resumedTargets.pathToPackageJson = packageJsonPath
    }
    catch {
      return undefined
    }
  }

  if (!resumedTargets.capacitorConfigPath && savedTargets.capacitorConfigPath) {
    try {
      const capacitorConfigPath = resolveCapacitorConfigTargetPath(savedTargets.capacitorConfigPath, initialCwd)
      const configLoadDir = resolveInitDirectoryPath(savedTargets.configLoadDir, initialCwd)
      if (!capacitorConfigPath || !configLoadDir)
        return undefined
      resumedTargets.capacitorConfigPath = capacitorConfigPath
      resumedTargets.configLoadDir = configLoadDir
    }
    catch {
      return undefined
    }
  }

  if (!resumedTargets.mainFilePath && savedTargets.mainFilePath) {
    try {
      const mainFilePath = resolveInitTargetPath(savedTargets.mainFilePath, 'Main file path', initialCwd)
      if (!mainFilePath || !/\.[cm]?[jt]sx?$/.test(mainFilePath))
        return undefined
      resumedTargets.mainFilePath = mainFilePath
    }
    catch {
      return undefined
    }
  }

  return resumedTargets
}

function getInitConfigLoadDir(projectDir: string): string {
  return globalCapacitorConfigPath ? globalConfigLoadDir ?? projectDir : projectDir
}
let globalCodeDiff: InitCodeDiff | undefined
let globalEncryptionSummary: InitEncryptionSummary | undefined
let globalCurrentStepNumber = 0
let globalAutoTestChange: InitAutoTestChange | undefined

const CODE_DIFF_CONTEXT_LINES = 5

function getNativePlatformAvailability(config?: CapacitorConfigSnapshot, rootDir = cwd()) {
  const iosDir = getPlatformDirFromCapacitorConfig(config, 'ios')
  const androidDir = getPlatformDirFromCapacitorConfig(config, 'android')
  return {
    iosDir,
    androidDir,
    ios: existsSync(join(rootDir, iosDir)),
    android: existsSync(join(rootDir, androidDir)),
  }
}
async function withTemporaryCwd<T>(targetDir: string, action: () => Promise<T>): Promise<T> {
  const previousCwd = cwd()
  try {
    chdir(targetDir)
    return await action()
  }
  finally {
    chdir(previousCwd)
  }
}

function getInitRecoveryCommands() {
  const pm = getPMAndCommand()
  return {
    pm,
    doctor: formatRunnerCommand(pm.runner, ['@capgo/cli@latest', 'doctor']),
    buildInit: formatRunnerCommand(pm.runner, ['@capgo/cli@latest', 'build', 'init']),
    capAddIos: formatRunnerCommand(pm.runner, ['cap', 'add', 'ios']),
    capAddAndroid: formatRunnerCommand(pm.runner, ['cap', 'add', 'android']),
    capSyncIos: formatRunnerCommand(pm.runner, ['cap', 'sync', 'ios']),
    capSyncAndroid: formatRunnerCommand(pm.runner, ['cap', 'sync', 'android']),
  }
}

export function getGitRepoStatus(startDir = cwd()): GitRepoStatus {
  const repoResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    stdio: 'pipe',
    encoding: 'utf8',
  })

  if (repoResult.error) {
    return {
      inRepo: false,
      clean: true,
      entries: [],
      error: formatError(repoResult.error),
    }
  }

  if (repoResult.status !== 0) {
    return {
      inRepo: false,
      clean: true,
      entries: [],
    }
  }

  const repoRoot = repoResult.stdout?.toString().trim()
  if (!repoRoot) {
    return {
      inRepo: false,
      clean: true,
      entries: [],
    }
  }

  const statusResult = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  })

  if (statusResult.error) {
    return {
      inRepo: true,
      clean: false,
      repoRoot,
      entries: [],
      error: formatError(statusResult.error),
    }
  }

  if (statusResult.status !== 0) {
    return {
      inRepo: true,
      clean: false,
      repoRoot,
      entries: [],
      error: statusResult.stderr?.toString().trim() || statusResult.stdout?.toString().trim() || `git status exited with code ${statusResult.status}`,
    }
  }

  const entries = statusResult.stdout
    ?.toString()
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean) ?? []

  return {
    inRepo: true,
    clean: entries.length === 0,
    repoRoot,
    entries,
  }
}

export function getInitUpdaterPluginConfig(appId: string, directInstall: boolean) {
  return {
    version: initNativeBundleVersion,
    appId,
    autoUpdate: directInstall ? 'always' : 'atBackground',
    ...(directInstall
      ? {
          autoSplashscreen: true,
        }
      : {}),
  }
}

export function getInitOtaVersionBase(pkgVersion: string) {
  try {
    const parsed = parse(pkgVersion)
    if (parsed.major === 0)
      return format(parsed)
  }
  catch {
  }

  return initNativeBundleVersion
}

export function getInitSuggestedOtaVersion(pkgVersion: string) {
  try {
    return format(increment(parse(getInitOtaVersionBase(pkgVersion)), 'patch'))
  }
  catch {
    return '0.0.1'
  }
}

export function applyInitAutoTestChange(filePath: string, content: string): { kind: InitAutoTestChangeKind, content: string } | undefined {
  if (filePath.endsWith('.html')) {
    if (content.includes('<body>') && !content.includes('capgo-test-banner')) {
      return {
        kind: 'html-banner',
        content: content.replace('<body>', `<body>\n${htmlAutoTestInjection}`),
      }
    }
    return undefined
  }

  if (filePath.endsWith('.vue')) {
    if (content.includes('<template>') && !content.includes('capgo-test-vue')) {
      return {
        kind: 'vue-banner',
        content: content.replace('<template>', `<template>\n${vueAutoTestInjection}`),
      }
    }
    return undefined
  }

  if (filePath.endsWith('.css')) {
    if (!content.includes('capgo-test-background')) {
      const insertionIndex = getCssAutoTestInsertionIndex(content)
      return {
        kind: 'css-background',
        content: `${content.slice(0, insertionIndex)}${cssAutoTestInjection}${content.slice(insertionIndex)}`,
      }
    }
  }

  return undefined
}

export function revertInitAutoTestChangeContent(kind: InitAutoTestChangeKind, content: string): string | undefined {
  if (kind === 'html-banner') {
    const reverted = content.replace(`<body>\n${htmlAutoTestInjection}`, '<body>')
    return reverted !== content ? reverted : undefined
  }

  if (kind === 'vue-banner') {
    const reverted = content.replace(`<template>\n${vueAutoTestInjection}`, '<template>')
    return reverted !== content ? reverted : undefined
  }

  if (kind === 'css-background') {
    const reverted = content.replace(cssAutoTestInjection, '')
    return reverted !== content ? reverted : undefined
  }

  return undefined
}

function isCssWhitespace(char?: string) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f'
}

function skipCssWhitespace(content: string, startIndex: number) {
  let index = startIndex
  while (index < content.length && isCssWhitespace(content[index]))
    index += 1
  return index
}

function readCssHeaderRule(content: string, startIndex: number, rule: '@charset' | '@import') {
  const ruleStart = skipCssWhitespace(content, startIndex)
  if (content.slice(ruleStart, ruleStart + rule.length).toLowerCase() !== rule)
    return startIndex

  const semicolonIndex = content.indexOf(';', ruleStart + rule.length)
  if (semicolonIndex === -1)
    return startIndex

  return skipCssWhitespace(content, semicolonIndex + 1)
}

function getCssAutoTestInsertionIndex(content: string) {
  let index = content.startsWith('\uFEFF') ? 1 : 0
  index = readCssHeaderRule(content, index, '@charset')

  while (true) {
    const nextIndex = readCssHeaderRule(content, index, '@import')
    if (nextIndex === index)
      return index
    index = nextIndex
  }
}

function getGitStatusEntryPath(entry: string) {
  const rawPath = entry.slice(3).trim()
  const renameSeparator = ' -> '
  if (!rawPath.includes(renameSeparator))
    return rawPath

  return rawPath.slice(rawPath.lastIndexOf(renameSeparator) + renameSeparator.length)
}

export function isOnlyAllowedInitAutoTestChange(status: GitRepoStatus, allowedChange?: InitAutoTestChange) {
  if (!allowedChange || !status.inRepo || !status.repoRoot || status.error || status.clean || status.entries.length === 0)
    return false

  try {
    const repoRoot = realpathSync.native(status.repoRoot)
    const allowedFilePath = realpathSync.native(path.resolve(allowedChange.filePath))
    const dirtyPaths = status.entries
      .map(getGitStatusEntryPath)
      .filter(Boolean)
      .map(entryPath => realpathSync.native(path.resolve(repoRoot, entryPath)))

    if (dirtyPaths.length === 0 || !dirtyPaths.every(dirtyPath => dirtyPath === allowedFilePath))
      return false

    const currentContent = readFileSync(allowedFilePath, 'utf8')
    const revertedContent = revertInitAutoTestChangeContent(allowedChange.kind, currentContent)
    if (!revertedContent)
      return false

    const gitRelativePath = path.relative(repoRoot, allowedFilePath).split(path.sep).join('/')
    const indexedFile = spawnSync('git', ['show', `:${gitRelativePath}`], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    if (indexedFile.error || indexedFile.status !== 0)
      return false

    return indexedFile.stdout.toString() === revertedContent
  }
  catch {
    return false
  }
}

export function getDirtyGitStatusActionOptions(): { value: DirtyGitStatusAction, label: string, hint: string }[] {
  return [
    {
      value: 'check-again',
      label: 'Check again',
      hint: 'recommended after committing or stashing changes',
    },
    {
      value: 'continue-dirty',
      label: 'Continue anyway',
      hint: 'not recommended; onboarding may edit files',
    },
  ]
}

async function waitForGitRepoCleanRetry() {
  const ready = await pText({
    message: 'Type "ready" once the repository is clean and you want me to check again.',
    placeholder: 'ready',
    validate: (value) => {
      if (!value?.trim())
        return 'Type "ready" when the repository is clean.'
      if (value.trim().toLowerCase() !== 'ready')
        return 'Type "ready" when the repository is clean.'
    },
  })
  await cancelBeforeAuthenticatedOnboarding(ready)
}

async function ensureGitRepoCleanBeforeInit(allowedAutoTestChange?: InitAutoTestChange) {
  let warned = false

  while (true) {
    const status = getGitRepoStatus()
    if (status.error && !status.inRepo) {
      pLog.warn(`Could not verify git status, skipping clean-repo check: ${status.error}`)
      return
    }

    if (!status.inRepo)
      return

    if (status.error) {
      warned = true
      pLog.error(`Could not verify git status for ${status.repoRoot}: ${status.error}`)
      pLog.info('Fix the git error first, then retry onboarding.')
      await waitForGitRepoCleanRetry()
      continue
    }

    if (status.clean) {
      if (warned)
        pLog.success('Git repository is clean ✅')
      return
    }

    if (isOnlyAllowedInitAutoTestChange(status, allowedAutoTestChange))
      return

    warned = true
    pLog.warn(`Git repository is not clean: ${status.repoRoot}`)
    for (const entry of status.entries.slice(0, 10)) {
      pLog.warn(`  ${entry}`)
    }
    if (status.entries.length > 10) {
      pLog.warn(`  ...and ${status.entries.length - 10} more`)
    }
    pLog.info('Clean, commit, or stash those changes before init continues, or continue anyway if you accept the risk.')

    const action = await pSelect<DirtyGitStatusAction>({
      message: 'How do you want to handle the dirty git status?',
      options: getDirtyGitStatusActionOptions(),
    })
    await cancelBeforeAuthenticatedOnboarding(action)

    if (action === 'continue-dirty') {
      pLog.warn('Continuing with dirty git status. This is not recommended.')
      return
    }
  }
}

function writeInitSupportBundle(error: string, extraSections: { title: string, lines: string[] }[] = []) {
  const currentStep = globalCurrentStepNumber > 0
    ? `Step ${globalCurrentStepNumber}/${initOnboardingSteps.length} · ${initOnboardingSteps[globalCurrentStepNumber - 1]?.title ?? 'Unknown step'}`
    : undefined
  const { pm, doctor, capAddIos, capAddAndroid } = getInitRecoveryCommands()

  return writeOnboardingSupportBundle({
    kind: 'init',
    appId: globalAppId,
    currentStep,
    packageManager: pm.pm,
    cwd: cwd(),
    error,
    commands: [doctor, capAddIos, capAddAndroid],
    docs: [
      'https://capgo.app/docs/getting-started/onboarding/',
      'https://capgo.app/docs/getting-started/add-an-app/',
    ],
    sections: [
      {
        title: 'Onboarding state',
        lines: [
          `Channel: ${globalChannelName}`,
          `Platform: ${globalPlatform}`,
          `Current version: ${globalCurrentVersion ?? 'unknown'}`,
        ],
      },
      ...extraSections,
    ],
  })
}

// Read the verbose internal log (raw provider/API errors, secret-redacted) so
// it can be folded into the support bundle's "Internal log" section.
function readInitInternalLogLines(): string[] {
  const internalLogPath = getInternalLogPath()
  if (!internalLogPath)
    return []
  try {
    return readFileSync(internalLogPath, 'utf8').split('\n')
  }
  catch {
    return []
  }
}

// Init-flavoured contact-support flow: confirm gate → write bundle → copy the
// .log.gz path → reveal in Finder (macOS) → open a pre-filled mailto. There's
// no build log in init, so the support bundle carries diagnostics + the
// internal log only. Every step but "write the bundle" is best-effort.
async function runInitContactSupport(failureText: string, supportPlatform?: PlatformChoice): Promise<void> {
  await contactSupport({
    subject: `Capgo Builder onboarding support — ${globalAppId ?? 'unknown'}`,
    body: `Hi Capgo team,\n\nI hit an error during Capgo Builder onboarding.\n\nApp: ${globalAppId ?? 'unknown'}\nError: ${failureText}`,
    confirm: async (msg, logPath) => {
      for (;;) {
        const choice = await pSelect({
          message: msg,
          options: [
            { value: 'yes', label: '📨  Yes, send to support' },
            { value: 'view', label: '👀  View logs first (opens the file)' },
            { value: 'no', label: '✖  Cancel' },
          ],
        })
        if (pIsCancel(choice) || choice === 'no')
          return false
        if (choice === 'view') {
          pLog.info(`Logs to be sent: ${logPath}`)
          try { await open(logPath) }
          catch { /* best-effort: just the path above */ }
          continue
        }
        return true
      }
    },
    buildFiles: () => writeSupportBundleFiles({
      kind: 'init',
      appId: globalAppId,
      error: failureText,
      sections: [{ title: 'Internal log', lines: readInitInternalLogLines() }],
    }),
    copyPath: p => copyToClipboard(p).ok,
    reveal: p => revealInFinder(p),
    openUrl: u => open(u),
    print: msg => pLog.info(msg),
    upload: async (gzPath) => {
      const key = findSavedKeySilent()
      if (!key)
        return null
      const spinner = pSpinner()
      spinner.start('Uploading your logs to Capgo support…')
      const r = await uploadSupportLogs({ apiHost: globalSupaHost ?? defaultApiHost, apikey: key, appId: globalAppId, platform: supportPlatform, gzPath })
      spinner.stop(r ? 'Logs uploaded.' : 'Logs upload unavailable — falling back to attaching the file.')
      return r
    },
  })
}

async function runInitDoctorDiagnostics(): Promise<void> {
  try {
    await getInfoInternal({ packageJson: globalPathToPackageJson }, false)
  }
  catch (error) {
    pLog.warn(`Doctor found an issue: ${formatError(error)}`)
  }
}

async function exitCanceledInitOnboarding(orgId: string, apikey: string, message = 'You can resume the onboarding anytime by running the same command again'): Promise<never> {
  await markInitSnag(orgId, apikey, 'canceled', undefined, '🤷')
  pOutro(`Bye 👋\n💡 ${message}`)
  return await exitAfterFinishingReplay(1)
}

// Render an init-time file path with its project directory prefix so users
// can tell which nested project was modified when they run `capgo init` from
// a parent folder (e.g. `CLI/src/main.tsx` instead of `src/main.tsx`).
function formatInitFilePath(filePath: string): string {
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd(), filePath)
    const cwdPath = cwd()
    const parentOfCwd = path.dirname(cwdPath)
    // If cwd has no meaningful parent (e.g. `/`), fall back to the original path.
    if (parentOfCwd === cwdPath) {
      return filePath
    }
    const rel = path.relative(parentOfCwd, absolute)
    return rel.length > 0 ? rel : filePath
  }
  catch {
    return filePath
  }
}

function buildCodeDiffLines(beforeContent: string, afterContent: string, contextSize: number) {
  const beforeLines = beforeContent.length === 0 ? [] : beforeContent.split('\n')
  const afterLines = afterContent.split('\n')

  // Find the first line index where the two diverge.
  let start = 0
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start++
  }

  // Find the last line index (from the end) where they still diverge.
  let endBefore = beforeLines.length - 1
  let endAfter = afterLines.length - 1
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore--
    endAfter--
  }

  // No divergence — nothing to show.
  if (endAfter < start) {
    return []
  }

  const contextStart = Math.max(0, start - contextSize)
  const contextEnd = Math.min(afterLines.length - 1, endAfter + contextSize)

  const diffLines: { lineNumber: number, text: string, kind: 'context' | 'add' }[] = []
  for (let i = contextStart; i <= contextEnd; i++) {
    diffLines.push({
      lineNumber: i + 1,
      text: afterLines[i] ?? '',
      kind: i >= start && i <= endAfter ? 'add' : 'context',
    })
  }
  return diffLines
}

function readTmpObj() {
  tmpObject ??= readdirSync(tmp.tmpdir)
    .map((name) => { return { name, full: `${tmp.tmpdir}/${name}` } })
    .find(obj => obj.name.startsWith('capgocli'))
    ?.full
    ?? tmp.fileSync({ prefix: 'capgocli' }).name
}

function getTmpObjectPath() {
  readTmpObj()
  if (!tmpObject)
    throw new Error('Unable to allocate onboarding state file')
  return tmpObject
}

function findNearestNamedFile(startDir: string, fileNames: string[]) {
  let currentDir = startDir
  const rootDir = path.parse(currentDir).root

  while (true) {
    for (const fileName of fileNames) {
      const candidate = join(currentDir, fileName)
      if (existsSync(candidate))
        return candidate
    }

    if (currentDir === rootDir)
      break

    const parent = dirname(currentDir)
    if (parent === currentDir)
      break
    currentDir = parent
  }

  return undefined
}

function findNearestPackageJson(startDir: string) {
  return findNearestNamedFile(startDir, [PACKNAME])
}

function readExistingFile(filePath: string | undefined) {
  if (!filePath || !existsSync(filePath))
    return undefined
  return readFileSync(filePath, 'utf8')
}

function getFrameworkKind(projectType: string): keyof typeof frameworkSetupGuides | undefined {
  if (projectType.startsWith('nextjs-'))
    return 'nextjs'
  if (projectType.startsWith('nuxtjs-'))
    return 'nuxtjs'
  if (projectType.startsWith('sveltekit-'))
    return 'sveltekit'
  return undefined
}

function getFrameworkDisplayName(projectType: string) {
  const frameworkKind = getFrameworkKind(projectType)
  if (frameworkKind === 'nextjs')
    return 'Next.js'
  if (frameworkKind === 'nuxtjs')
    return 'Nuxt'
  if (frameworkKind === 'sveltekit')
    return 'SvelteKit'
  return 'web'
}

function getSuggestedWebDir(projectType: string) {
  const frameworkKind = getFrameworkKind(projectType)
  if (frameworkKind === 'nextjs')
    return 'out'
  if (frameworkKind === 'nuxtjs')
    return '.output/public'
  if (frameworkKind === 'sveltekit')
    return 'build'
  return 'dist'
}

function getPackageJsonData(packageJsonPath: string | undefined) {
  if (!packageJsonPath || !existsSync(packageJsonPath))
    return undefined

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string }
  }
  catch {
    return undefined
  }
}

function getSuggestedAppName(projectDir: string) {
  const packageJson = getPackageJsonData(findNearestPackageJson(projectDir))
  const rawName = packageJson?.name?.split('/').pop() || path.basename(projectDir)
  return rawName
    .replaceAll(/[-_]+/g, ' ')
    .replaceAll(/\b\w/g, char => char.toUpperCase())
}

function getFrameworkSetupIssues(projectType: string, projectDir: string, capacitorConfigPath?: string) {
  const frameworkKind = getFrameworkKind(projectType)
  if (!frameworkKind)
    return []

  const issues: string[] = []

  if (frameworkKind === 'nextjs') {
    const nextConfig = readExistingFile(findNearestNamedFile(projectDir, ['next.config.ts', 'next.config.js', 'next.config.mjs']))
    if (!nextConfig?.includes('output') || !nextConfig.includes('export')) {
      issues.push('Next.js must use static export (`output: \'export\'`).')
    }
    const capacitorConfig = readExistingFile(capacitorConfigPath)
    if (capacitorConfig && !nextWebDirPattern.test(capacitorConfig)) {
      issues.push('Capacitor `webDir` should point to `out` for Next.js.')
    }
  }

  if (frameworkKind === 'nuxtjs') {
    const nuxtConfig = readExistingFile(findNearestNamedFile(projectDir, ['nuxt.config.ts', 'nuxt.config.js']))
    if (!nuxtConfig?.includes('preset') || !nuxtConfig.includes('static')) {
      issues.push('Nuxt must use static Nitro output (`nitro.preset = "static"`).')
    }
    const capacitorConfig = readExistingFile(capacitorConfigPath)
    if (capacitorConfig && !nuxtWebDirPattern.test(capacitorConfig)) {
      issues.push('Capacitor `webDir` should point to `.output/public` for Nuxt.')
    }
  }

  if (frameworkKind === 'sveltekit') {
    const svelteConfig = readExistingFile(findNearestNamedFile(projectDir, ['svelte.config.js', 'svelte.config.ts']))
    if (!svelteConfig?.includes('adapter-static')) {
      issues.push('SvelteKit must use `@sveltejs/adapter-static` before Capacitor sync works reliably.')
    }
  }

  return issues
}
async function exitBeforeAuthenticatedOnboarding() {
  pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
  return await exitAfterFinishingReplay(1)
}

async function cancelBeforeAuthenticatedOnboarding(command: CancelablePromptValue) {
  if (pIsCancel(command)) {
    pCancel('Operation cancelled.')
    await exitBeforeAuthenticatedOnboarding()
  }
}

function getCreateAppTemplateCommand() {
  const { pm } = getPMAndCommand()
  if (pm === 'bun') {
    return {
      display: 'bun create @capacitor/app@latest',
      command: 'bun',
      args: ['create', '@capacitor/app@latest'],
    }
  }

  return {
    display: 'npm init @capacitor/app@latest',
    command: 'npm',
    args: ['init', '@capacitor/app@latest'],
  }
}

async function waitUntilSetupIsDone(message = 'Type "ready" when the setup is done.') {
  while (true) {
    const ready = await pText({
      message,
      placeholder: 'ready',
      validate: (value) => {
        if (!value?.trim())
          return 'Type "ready" when you are done.'
        if (value.trim().toLowerCase() !== 'ready')
          return 'Type "ready" when you are done.'
      },
    })
    await cancelBeforeAuthenticatedOnboarding(ready)
    if (typeof ready === 'string' && ready.trim().toLowerCase() === 'ready')
      return
  }
}

async function askForAppName(message: string, initialValue: string) {
  const appName = await pText({
    message,
    placeholder: initialValue,
    validate: (value) => {
      if (!value?.trim())
        return 'App name is required'
    },
  })
  await cancelBeforeAuthenticatedOnboarding(appName)
  return (appName as string).trim()
}

async function askForWebDir(projectType: string) {
  const suggestedWebDir = getSuggestedWebDir(projectType)
  const webDir = await pText({
    message: 'Enter the web build directory to use for Capacitor:',
    placeholder: suggestedWebDir,
    validate: (value) => {
      if (!value?.trim())
        return 'Web directory is required'
    },
  })
  await cancelBeforeAuthenticatedOnboarding(webDir)
  return (webDir as string).trim()
}

async function maybeRunCapacitorInit(projectDir: string, projectType: string, initialAppId?: string) {
  const shouldInitCapacitor = await pConfirm({
    message: 'Do you want me to install Capacitor here and run init now?',
    initialValue: true,
  })
  await cancelBeforeAuthenticatedOnboarding(shouldInitCapacitor)

  if (!shouldInitCapacitor)
    await exitBeforeAuthenticatedOnboarding()

  const appName = await askForAppName('App name for Capacitor:', getSuggestedAppName(projectDir))
  const capacitorAppId = initialAppId || await askForAppId('Enter your appId for Capacitor:')
  const webDir = await askForWebDir(projectType)
  const spinner = pSpinner()
  const pm = getPMAndCommand()

  try {
    spinner.start(`Installing Capacitor packages with ${pm.installCommand}`)
    const installCoreResult = spawnSync(pm.pm, [pm.command, '@capacitor/core'], { stdio: 'pipe', cwd: projectDir })
    if (installCoreResult.error)
      throw installCoreResult.error
    if (installCoreResult.status !== 0) {
      const stderr = installCoreResult.stderr?.toString().trim()
      const stdout = installCoreResult.stdout?.toString().trim()
      throw new Error(stderr || stdout || `${pm.installCommand} @capacitor/core exited with code ${installCoreResult.status}`)
    }

    const installCliResult = spawnSync(pm.pm, [pm.command, '-D', '@capacitor/cli'], { stdio: 'pipe', cwd: projectDir })
    if (installCliResult.error)
      throw installCliResult.error
    if (installCliResult.status !== 0) {
      const stderr = installCliResult.stderr?.toString().trim()
      const stdout = installCliResult.stdout?.toString().trim()
      throw new Error(stderr || stdout || `${pm.installCommand} -D @capacitor/cli exited with code ${installCliResult.status}`)
    }

    spinner.message(`Running: ${pm.runner} cap init "${appName}" "${capacitorAppId}" --web-dir ${webDir}`)
    const initResult = spawnSync(pm.runner, ['cap', 'init', appName, capacitorAppId, '--web-dir', webDir], { stdio: 'pipe', cwd: projectDir })
    if (initResult.error)
      throw initResult.error
    if (initResult.status !== 0) {
      const stderr = initResult.stderr?.toString().trim()
      const stdout = initResult.stdout?.toString().trim()
      throw new Error(stderr || stdout || `cap init exited with code ${initResult.status}`)
    }
    spinner.stop('Capacitor init done ✅')
    pLog.info(`Capacitor was initialized with webDir ${webDir}.`)
    return capacitorAppId
  }
  catch (error) {
    spinner.stop('Capacitor init failed ❌')
    pLog.error(formatError(error))
    const retry = await pConfirm({
      message: 'Capacitor init failed. Do you want to try again?',
      initialValue: true,
    })
    await cancelBeforeAuthenticatedOnboarding(retry)
    if (retry)
      return maybeRunCapacitorInit(projectDir, projectType, capacitorAppId)
    await exitBeforeAuthenticatedOnboarding()
  }
}

async function runCapacitorPlatformAdd(platformName: 'ios' | 'android', runner: string, commandCwd = cwd()): Promise<boolean> {
  const command = formatRunnerCommand(runner, ['cap', 'add', platformName])
  const spinner = pSpinner()
  const runMessage = commandCwd === cwd()
    ? `Running: ${command}`
    : `Running in ${commandCwd}: ${command}`
  spinner.start(runMessage)

  let parsedRunner: { command: string, args: string[] }
  try {
    parsedRunner = splitRunnerCommand(runner)
  }
  catch (error) {
    spinner.stop(`Could not add ${platformName} automatically ❌`)
    pLog.error(formatError(error))
    return false
  }

  const result = await runInheritedCommand(parsedRunner.command, [...parsedRunner.args, 'cap', 'add', platformName], { cwd: commandCwd })
  if (result.error || result.status !== 0) {
    spinner.stop(`Could not add ${platformName} automatically ❌`)
    pLog.error(formatInheritedCommandFailure(result))
    return false
  }

  spinner.stop(`${platformName.toUpperCase()} platform added ✅`)
  return true
}

async function runCreateAppTemplate() {
  const templateCommand = getCreateAppTemplateCommand()
  stopInitInkSession({ text: 'Starting Capacitor app template creation...', tone: 'green' })
  const result = await runInheritedCommand(templateCommand.command, templateCommand.args)
  if (result.error || result.status !== 0) {
    stdout.write(`Capacitor app template creation failed. Run ${templateCommand.display} manually and try again.\n`)
    if (result.error)
      pLog.error(formatError(result.error))
    return await exitAfterFinishingReplay(1)
  }

  stdout.write('Capacitor app template creation finished. Run init again from the new app folder.\n')
  return await exitAfterFinishingReplay(0)
}

async function ensureWorkspaceReadyForInit(initialAppId?: string): Promise<string | undefined> {
  while (true) {
    const currentDir = cwd()
    const nearestCapacitorConfig = findNearestCapacitorConfig(currentDir)
    const nearestPackageJson = findNearestPackageJson(currentDir)
    const projectDir = nearestCapacitorConfig?.dir || (nearestPackageJson ? dirname(nearestPackageJson) : currentDir)
    const projectType = await findProjectType({ quiet: true, packageJsonPath: globalPathToPackageJson })
    const frameworkKind = getFrameworkKind(projectType)

    if (nearestCapacitorConfig?.dir === currentDir) {
      const frameworkIssues = getFrameworkSetupIssues(projectType, projectDir, nearestCapacitorConfig.file)
      if (frameworkIssues.length === 0)
        return

      pLog.warn(`${getFrameworkDisplayName(projectType)} is detected, but the Capacitor setup is not ready yet.`)
      for (const issue of frameworkIssues) {
        pLog.warn(issue)
      }
      if (frameworkKind) {
        pLog.info(`Follow this guide to finish the setup: ${frameworkSetupGuides[frameworkKind]}`)
      }
      await waitUntilSetupIsDone()
      continue
    }

    if (nearestCapacitorConfig) {
      return
    }

    if (frameworkKind) {
      const frameworkIssues = getFrameworkSetupIssues(projectType, projectDir)
      if (frameworkIssues.length > 0) {
        pLog.warn(`${getFrameworkDisplayName(projectType)} project detected, but the setup is not ready yet.`)
        for (const issue of frameworkIssues) {
          pLog.warn(issue)
        }
        pLog.info(`Follow this guide: ${frameworkSetupGuides[frameworkKind]}`)
        await waitUntilSetupIsDone()
        continue
      }

      const initializedAppId = await maybeRunCapacitorInit(projectDir, projectType, initialAppId)
      return initializedAppId
    }

    if (nearestPackageJson) {
      pLog.warn('This looks like a web app, but Capacitor is not initialized yet.')
      pLog.info(`Follow the Capacitor getting started guide: ${capacitorGettingStartedUrl}`)
      const initializedAppId = await maybeRunCapacitorInit(projectDir, projectType, initialAppId)
      return initializedAppId
    }

    const templateCommand = getCreateAppTemplateCommand()
    const createAppNow = await pConfirm({
      message: `This folder is not a web app yet. Do you want to start ${templateCommand.display} now?`,
      initialValue: true,
    })
    await cancelBeforeAuthenticatedOnboarding(createAppNow)
    if (createAppNow) {
      await runCreateAppTemplate()
    }
    else {
      pLog.info(`Create a new Capacitor app first with: ${templateCommand.display}`)
      pLog.info('Then run this onboarding again from the new app folder.')
      await exitBeforeAuthenticatedOnboarding()
    }
  }
}

let globalOrgId: string | undefined
let globalOrgName: string | undefined

function markStepDone(step: number, pathToPackageJson?: string, channelName?: string) {
  try {
    writeFileSync(getTmpObjectPath(), JSON.stringify({
      step_done: step,
      orgId: globalOrgId,
      orgName: globalOrgName,
      appId: globalAppId,
      pathToPackageJson: pathToPackageJson ?? globalPathToPackageJson,
      capacitorConfigPath: globalCapacitorConfigPath,
      configLoadDir: globalConfigLoadDir,
      mainFilePath: globalMainFilePath,
      channelName: channelName ?? globalChannelName,
      platform: globalPlatform,
      delta: globalDelta,
      currentVersion: globalCurrentVersion,
      codeDiff: globalCodeDiff,
      encryptionSummary: globalEncryptionSummary,
      autoTestChange: globalAutoTestChange,
      nodeModulesPath: globalNodeModulesPath,
    }))
    if (pathToPackageJson) {
      globalPathToPackageJson = pathToPackageJson
    }
    if (channelName) {
      globalChannelName = channelName
    }
  }
  catch (err) {
    pLog.error(`Cannot mark step as done in the CLI, error:\n${err}`)
    pLog.warn('Onboarding will continue but please report it to the capgo team!')
  }
}

interface ResumeResult {
  stepDone: number
  orgId: string
  orgName: string
  appId?: string
}

async function tryResumeOnboarding(apikey: string, initialTargets: InitTargetPaths, initialCwd: string): Promise<ResumeResult | undefined> {
  try {
    const rawData = readFileSync(getTmpObjectPath(), 'utf-8')
    if (!rawData || rawData.length === 0)
      return undefined

    const {
      step_done,
      orgId,
      orgName,
      appId: savedAppId,
      pathToPackageJson,
      capacitorConfigPath,
      configLoadDir,
      mainFilePath,
      nodeModulesPath,
      channelName,
      platform,
      delta,
      currentVersion,
      codeDiff,
      encryptionSummary,
      autoTestChange,
    } = JSON.parse(rawData)
    if (!orgId || !step_done) {
      pLog.warn('⚠️  Found previous onboarding progress, but it was saved in an older format.')
      pLog.info('   Starting fresh. Your previous progress cannot be resumed.')
      return undefined
    }

    pLog.info(formatInitResumeMessage(step_done, initOnboardingSteps.length))
    if (orgName) {
      pLog.info(`   Organization: ${orgName}`)
    }
    const resumeChoice = await pSelect({
      message: 'Would you like to continue from where you left off?',
      options: [
        { value: 'yes', label: '✅ Yes, continue' },
        { value: 'no', label: '❌ No, start over' },
      ],
    })
    await cancelCommand(resumeChoice, orgId, apikey)
    if (resumeChoice === 'yes') {
      const resumedTargets = resolveResumedInitTargets(initialTargets, {
        pathToPackageJson: typeof pathToPackageJson === 'string' ? pathToPackageJson : undefined,
        capacitorConfigPath: typeof capacitorConfigPath === 'string' ? capacitorConfigPath : undefined,
        configLoadDir: typeof configLoadDir === 'string' ? configLoadDir : undefined,
        mainFilePath: typeof mainFilePath === 'string' ? mainFilePath : undefined,
      }, initialCwd)
      if (!resumedTargets) {
        pLog.warn('Saved onboarding targets are no longer available. Starting over.')
        cleanupStepsDone()
        globalCodeDiff = undefined
        setInitCodeDiff(undefined)
        globalEncryptionSummary = undefined
        setInitEncryptionSummary(undefined)
        globalAutoTestChange = undefined
        return undefined
      }
      globalPathToPackageJson = resumedTargets.pathToPackageJson
      globalCapacitorConfigPath = resumedTargets.capacitorConfigPath
      globalConfigLoadDir = resumedTargets.configLoadDir
      globalMainFilePath = resumedTargets.mainFilePath
      setConfigWriteTarget(globalCapacitorConfigPath)
      if (typeof nodeModulesPath === 'string' && nodeModulesPath.length > 0) {
        globalNodeModulesPath = nodeModulesPath
      }
      if (channelName) {
        globalChannelName = channelName
      }
      if (platform === 'ios' || platform === 'android') {
        globalPlatform = platform
      }
      if (typeof delta === 'boolean') {
        globalDelta = delta
      }
      if (typeof currentVersion === 'string' && currentVersion.length > 0) {
        globalCurrentVersion = currentVersion
      }
      if (savedAppId) {
        globalAppId = savedAppId
      }
      if (
        autoTestChange
        && typeof autoTestChange === 'object'
        && typeof autoTestChange.filePath === 'string'
        && typeof autoTestChange.displayPath === 'string'
        && ['html-banner', 'vue-banner', 'css-background'].includes(autoTestChange.kind)
      ) {
        globalAutoTestChange = {
          filePath: autoTestChange.filePath,
          displayPath: autoTestChange.displayPath,
          kind: autoTestChange.kind as InitAutoTestChangeKind,
        }
      }
      // Only carry the diff forward if the user is about to land on step 5 (where it's displayed).
      if (step_done === 4 && codeDiff && typeof codeDiff === 'object' && typeof codeDiff.filePath === 'string' && Array.isArray(codeDiff.lines)) {
        const restoredLines: { lineNumber: number, text: string, kind: 'context' | 'add' }[] = []
        for (const rawLine of codeDiff.lines as unknown[]) {
          if (
            typeof rawLine === 'object'
            && rawLine !== null
            && typeof (rawLine as { lineNumber?: unknown }).lineNumber === 'number'
            && typeof (rawLine as { text?: unknown }).text === 'string'
            && ((rawLine as { kind?: unknown }).kind === 'context' || (rawLine as { kind?: unknown }).kind === 'add')
          ) {
            const typed = rawLine as { lineNumber: number, text: string, kind: 'context' | 'add' }
            restoredLines.push({ lineNumber: typed.lineNumber, text: typed.text, kind: typed.kind })
          }
        }
        globalCodeDiff = {
          filePath: codeDiff.filePath,
          created: Boolean(codeDiff.created),
          lines: restoredLines,
          note: typeof codeDiff.note === 'string' ? codeDiff.note : undefined,
        }
      }
      // Carry the encryption summary panel forward if the user resumes
      // anywhere between step 5 (encryption added) and step 7 (build +
      // cap sync). We need the panel visible on step 6 (the "what
      // happened in step 5" callout) AND up to step 7, because the
      // outcome is only fully "enabled" once the native project has
      // been synced with the new public key.
      if (
        step_done >= 5
        && step_done < 7
        && encryptionSummary
        && typeof encryptionSummary === 'object'
        && typeof encryptionSummary.title === 'string'
        && typeof encryptionSummary.phase === 'string'
        && Array.isArray(encryptionSummary.lines)
      ) {
        const restoredEncryptionLines = (encryptionSummary.lines as unknown[])
          .filter((line): line is string => typeof line === 'string')
        const allowedPhases: InitEncryptionPhase[] = ['enabled', 'pending-sync', 'skipped', 'failed']
        const restoredPhase = allowedPhases.includes(encryptionSummary.phase as InitEncryptionPhase)
          ? (encryptionSummary.phase as InitEncryptionPhase)
          : 'skipped'
        globalEncryptionSummary = {
          phase: restoredPhase,
          title: encryptionSummary.title,
          lines: restoredEncryptionLines,
        }
        setInitEncryptionSummary(globalEncryptionSummary)
      }
      return { stepDone: step_done, orgId, orgName, appId: savedAppId }
    }

    // User chose to start over — delete the saved progress and drop any
    // restored code diff / encryption summary so a fresh manual path
    // doesn't re-show stale content.
    cleanupStepsDone()
    globalCodeDiff = undefined
    setInitCodeDiff(undefined)
    globalEncryptionSummary = undefined
    setInitEncryptionSummary(undefined)
    globalAutoTestChange = undefined
    globalNodeModulesPath = undefined
    return undefined
  }
  catch (err) {
    pLog.error(`Cannot read which steps have been completed, error:\n${err}`)
    pLog.warn('Onboarding will continue but please report it to the capgo team!')
    globalCodeDiff = undefined
    setInitCodeDiff(undefined)
    globalEncryptionSummary = undefined
    setInitEncryptionSummary(undefined)
    globalAutoTestChange = undefined
    globalNodeModulesPath = undefined
    return undefined
  }
}

function cleanupStepsDone() {
  globalAutoTestChange = undefined
  globalNodeModulesPath = undefined
  if (!tmpObject) {
    return
  }

  try {
    rmSync(tmpObject)
  }
  catch (err) {
    pLog.error(`Cannot delete the tmp steps file.\nError: ${err}`)
  }
}

async function cancelCommand(command: boolean | string | symbol, orgId: string, apikey: string) {
  if (pIsCancel(command)) {
    await markInitSnag(orgId, apikey, 'canceled', undefined, '🤷')
    pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
    return await exitAfterFinishingReplay()
  }
}

interface RecoveryOption<T extends string> {
  value: T
  label: string
  hint?: string
}

async function selectRecoveryOption<T extends string>(
  orgId: string,
  apikey: string,
  message: string,
  options: RecoveryOption<T>[],
  failureText = message,
  supportPlatform?: PlatformChoice,
): Promise<T> {
  type RecoveryChoice = T | '__doctor__' | '__email_support__' | '__support__' | '__cancel__'

  while (true) {
    const choice = await pSelect<RecoveryChoice>({
      message,
      options: [
        ...options,
        { value: '__email_support__', label: '📨 Email Capgo support' },
        { value: '__doctor__', label: 'Run doctor diagnostics now' },
        { value: '__support__', label: 'Save a support bundle' },
        { value: '__cancel__', label: 'Exit onboarding' },
      ],
    })

    if (pIsCancel(choice) || choice === '__cancel__') {
      await markInitSnag(orgId, apikey, 'canceled', undefined, '🤷')
      pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
      return await exitAfterFinishingReplay(1)
    }

    if (choice === '__doctor__') {
      try {
        await getInfoInternal({ packageJson: globalPathToPackageJson }, false)
      }
      catch (error) {
        pLog.warn(`Doctor found an issue: ${formatError(error)}`)
      }
      continue
    }

    if (choice === '__email_support__') {
      await runInitContactSupport(failureText, supportPlatform)
      continue
    }

    if (choice === '__support__') {
      const bundlePath = writeInitSupportBundle(failureText)
      if (bundlePath)
        pLog.info(`Saved support bundle to ${bundlePath}`)
      else
        pLog.warn('Could not save a support bundle automatically.')
      continue
    }

    return choice as T
  }
}

async function askForExistingDirectoryPath(orgId: string, apikey: string, message: string, placeholder?: string): Promise<string> {
  const selectedPath = await pText({
    message,
    placeholder,
    validate: (value) => {
      const trimmedValue = value?.trim()
      if (!trimmedValue)
        return 'Path is required.'
      if (!existsSync(trimmedValue))
        return `Path ${trimmedValue} does not exist`
      if (!statSync(trimmedValue).isDirectory())
        return 'Selected path is not a directory'
    },
  })

  if (pIsCancel(selectedPath)) {
    await cancelCommand(selectedPath, orgId, apikey)
  }

  return (selectedPath as string).trim()
}

/**
 * Find the nearest Capacitor config file by walking up the directory tree.
 */
function findNearestCapacitorConfig(startDir: string) {
  let currentDir = startDir
  const rootDir = path.parse(currentDir).root

  while (true) {
    for (const file of capacitorConfigFiles) {
      const candidate = join(currentDir, file)
      if (existsSync(candidate))
        return { dir: currentDir, file: candidate }
    }

    if (currentDir === rootDir)
      break

    const parent = dirname(currentDir)
    if (parent === currentDir)
      break
    currentDir = parent
  }

  return undefined
}

/**
 * Warn and optionally stop if onboarding is started outside the Capacitor project root.
 */
async function warnIfNotInCapacitorRoot() {
  const currentDir = cwd()
  const configHere = capacitorConfigFiles.some(file => existsSync(join(currentDir, file)))

  if (configHere)
    return

  const nearest = findNearestCapacitorConfig(currentDir)

  pLog.warn('Capacitor config not found in the current folder.')
  if (nearest) {
    pLog.info(`Found a capacitor config at: ${nearest.file}`)
    pLog.info(`You are currently in: ${currentDir}`)
  }
  else {
    pLog.info('No capacitor config was found in this folder or any parent directories.')
  }

  const currentFolder = path.basename(currentDir)
  if (currentFolder === 'ios' || currentFolder === 'android') {
    pLog.info('It looks like you are inside a platform folder (ios/android).')
    pLog.info('Try running the onboarding from the project root (the folder with capacitor.config.*).')
  }

  if (nearest) {
    const choice = await pSelect({
      message: 'How do you want to continue?',
      options: [
        { value: 'switch', label: `Switch to ${nearest.dir} and continue there` },
        { value: 'continue', label: 'Stay here and continue anyway' },
        { value: 'exit', label: 'Exit onboarding' },
      ],
    })

    if (pIsCancel(choice) || choice === 'exit') {
      pCancel('Operation cancelled.')
      return await exitAfterFinishingReplay(1)
    }

    if (choice === 'switch') {
      chdir(nearest.dir)
      pLog.info(`Switched to ${nearest.dir}`)
      return
    }

    return
  }

  const continueAnyway = await pConfirm({
    message: 'Are you sure you want to continue? If you do, the auto-configuration will probably not work from here.',
    initialValue: false,
  })

  if (pIsCancel(continueAnyway) || !continueAnyway) {
    pCancel('Operation cancelled.')
    return await exitAfterFinishingReplay(1)
  }
}

async function markInitSnag(orgId: string, apikey: string, event: string, appId?: string, icon = '✅') {
  const replaySessionId = getActiveCliReplaySessionId()
  return markSnag('onboarding-v2', orgId, apikey, event, appId, icon, replaySessionId ? { $session_id: replaySessionId } : undefined)
}

async function markStep(orgId: string, apikey: string, step: string, appId: string) {
  return markInitSnag(orgId, apikey, `onboarding-step-${step}`, appId)
}
/**
 * Save the app ID to the CapacitorUpdater plugin config.
 */
async function saveAppIdToCapacitorConfig(appId: string) {
  try {
    await updateConfigUpdater({ appId })
    pLog.info(`💾 Saved new app ID "${appId}" to CapacitorUpdater config`)
  }
  catch (err) {
    pLog.warn(`⚠️  Could not save app ID to capacitor config: ${err}`)
    pLog.info(`   You may need to manually update your capacitor.config file with the new app ID: ${appId}`)
  }
}

/**
 * When reusing an app created by the web onboarding flow, the dashboard app ID becomes authoritative.
 */
async function syncPendingAppIdToCapacitorConfig(appId: string) {
  try {
    const extConfig = await getConfigForWrite()
    extConfig.config.appId = appId
    extConfig.config.plugins ||= {}
    extConfig.config.plugins.CapacitorUpdater = {
      ...extConfig.config.plugins.CapacitorUpdater,
      appId,
    }
    await writeConfigUpdater(extConfig, true)
    pLog.info(`💾 Synced pending onboarding app ID "${appId}" to capacitor config`)
  }
  catch (err) {
    pLog.warn(`⚠️  Could not save app ID to capacitor config: ${err}`)
    pLog.info(`   You may need to manually update your capacitor.config file with the new app ID: ${appId}`)
  }
}

function logBrokenIosSync(details: string[], resetAdviceSummary: string, resetAdviceCommand: string, doctorCommand: string): void {
  pLog.error('Capgo iOS dependency sync verification failed.')
  for (const detail of details) {
    pLog.error(detail)
  }
  pLog.error('The native iOS project is still broken, so this build step cannot continue yet.')
  pLog.warn(resetAdviceSummary)
  pLog.info(resetAdviceCommand)
  pLog.info(`Diagnostics: ${doctorCommand}`)
}

function maybeWriteBrokenIosSyncSupportBundle(failureCount: number, details: string[], resetAdviceCommand: string, doctorCommand: string): void {
  if (failureCount < 2)
    return

  const supportBundlePath = writeInitSupportBundle('iOS dependency sync verification failed', [
    { title: 'Failure details', lines: details },
    { title: 'Recommended commands', lines: [resetAdviceCommand, doctorCommand] },
  ])
  if (supportBundlePath)
    pLog.info(`Support bundle: ${supportBundlePath}`)
  else
    pLog.warn('Could not save a support bundle automatically.')
}

async function maybeCancelAfterRepeatedIosSyncFailures(failureCount: number, orgId: string, apikey: string): Promise<void> {
  if (failureCount % 3 !== 0)
    return

  const cancelInit = await pConfirm({
    message: `iOS sync has failed ${failureCount} times. Do you want to cancel init?`,
    initialValue: false,
  })
  await cancelCommand(cancelInit, orgId, apikey)
  if (cancelInit)
    await exitCanceledInitOnboarding(orgId, apikey)
}

async function runNativeResetCommand(platformRunner: string, nativePlatform: PlatformChoice, successMessage: string, failureMessage: string): Promise<void> {
  const resetAdvice = getNativeProjectResetAdvice(platformRunner, nativePlatform)
  const resetSpinner = pSpinner()
  resetSpinner.start(`Running: ${resetAdvice.command}`)
  try {
    const parsedRunner = splitRunnerCommand(platformRunner)
    rmSync(nativePlatform, { recursive: true, force: true })

    const addResult = await runInheritedCommand(parsedRunner.command, [...parsedRunner.args, 'cap', 'add', nativePlatform])
    if (addResult.error || addResult.status !== 0)
      throw addResult.error ?? new Error(`cap add ${nativePlatform} failed with ${formatInheritedCommandFailure(addResult)}`)

    const syncResult = await runInheritedCommand(parsedRunner.command, [...parsedRunner.args, 'cap', 'sync', nativePlatform])
    if (syncResult.error || syncResult.status !== 0)
      throw syncResult.error ?? new Error(`cap sync ${nativePlatform} failed with ${formatInheritedCommandFailure(syncResult)}`)

    resetSpinner.stop(successMessage)
  }
  catch (err) {
    resetSpinner.stop(failureMessage)
    pLog.error(formatError(err))
  }
}

async function waitForReadyConfirmation(
  message: string,
  orgId: string,
  apikey: string,
  prompt = 'Type "ready" when the manual fix is done.',
  placeholder = 'ready',
): Promise<void> {
  pLog.info(message)

  while (true) {
    const ready = await pText({
      message: prompt,
      placeholder,
      validate: (value) => {
        if (!value?.trim())
          return 'Type "ready" to retry.'
        if (value.trim().toLowerCase() !== 'ready')
          return 'Type "ready" to retry.'
      },
    })
    if (pIsCancel(ready)) {
      await cancelCommand(ready, orgId, apikey)
      continue
    }
    if (typeof ready === 'string' && ready.trim().toLowerCase() === 'ready')
      return
  }
}

async function waitForReadyRetry(message: string, orgId: string, apikey: string, placeholder = 'ready'): Promise<void> {
  await waitForReadyConfirmation(message, orgId, apikey, 'Type "ready" when the iOS folder is fixed.', placeholder)
}

async function handleBrokenIosSync(platformRunner: string, details: string[], orgId: string, apikey: string, failureCount: number) {
  const resetAdvice = getNativeProjectResetAdvice(platformRunner, 'ios')
  const { doctor } = getInitRecoveryCommands()
  logBrokenIosSync(details, resetAdvice.summary, resetAdvice.command, doctor)
  maybeWriteBrokenIosSyncSupportBundle(failureCount, details, resetAdvice.command, doctor)
  await maybeCancelAfterRepeatedIosSyncFailures(failureCount, orgId, apikey)

  const runResetNow = await pConfirm({
    message: 'Would you like me to run this reset command for you now?',
    initialValue: true,
  })
  await cancelCommand(runResetNow, orgId, apikey)

  if (runResetNow) {
    await runNativeResetCommand(platformRunner, 'ios', 'iOS folder recreated and synced ✅', 'iOS folder reset failed ❌')
    return
  }

  await waitForReadyRetry('We will wait while you fix the iOS folder yourself.\nWhen you are ready, type "ready" and I will retry this step.', orgId, apikey)
}

function validateAppId(value: string | undefined): string | undefined {
  if (!value)
    return 'App ID is required'
  if (value.includes('--'))
    return 'App ID cannot contain "--"'
  if (!appIdRegex.test(value))
    return 'Invalid format. Use reverse domain notation (e.g., com.example.app)'
}

function validateChannelName(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim()
  if (!trimmedValue)
    return 'Channel name is required'
  if (!channelNameRegex.test(trimmedValue))
    return 'Use only letters, numbers, dot, dash, or underscore'
}

function normalizeConcreteVersion(version: string | undefined) {
  if (!version)
    return undefined

  const trimmedVersion = version.trim()
  if (!trimmedVersion || trimmedVersion === 'latest')
    return undefined
  if (canParse(trimmedVersion))
    return format(parse(trimmedVersion))

  const fallbackMatch = /\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?/i.exec(trimmedVersion)
  if (!fallbackMatch?.[0])
    return undefined
  if (!canParse(fallbackMatch[0]))
    return undefined
  return format(parse(fallbackMatch[0]))
}

async function askForAppId(message = 'Enter your appId:'): Promise<string> {
  const appId = await pText({
    message,
    validate: validateAppId,
  })

  if (pIsCancel(appId)) {
    pCancel('Operation cancelled.')
    pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
    return await exitAfterFinishingReplay()
  }

  return appId as string
}

async function ensureCapacitorProjectReady(
  orgId: string,
  apikey: string,
  appId: string,
  pendingApp?: PendingOnboardingApp,
) {
  const nearestConfig = findNearestCapacitorConfig(cwd())
  if (nearestConfig?.dir === cwd()) {
    return
  }

  if (nearestConfig) {
    await warnIfNotInCapacitorRoot()
    return
  }

  if (pendingApp?.existing_app === false) {
    const pm = getPMAndCommand()
    const appName = pendingApp.name?.trim() || appId
    pLog.info(`No Capacitor config was found for ${appId}.`)
    pLog.info('This app was created from the web onboarding as a new app.')

    const initCommand = `${pm.runner} cap init "${appName}" "${appId}"`
    const shouldInitCapacitor = await pConfirm({
      message: `Do you want me to run "${initCommand}" now?`,
      initialValue: true,
    })
    await cancelCommand(shouldInitCapacitor, orgId, apikey)

    if (shouldInitCapacitor) {
      const spinner = pSpinner()
      spinner.start(`Running: ${pm.runner} cap init "${appName}" "${appId}"`)
      try {
        const initResult = spawnSync(pm.runner, ['cap', 'init', appName, appId], { stdio: 'pipe' as const })
        if (initResult.error)
          throw initResult.error
        if (initResult.status !== 0) {
          const stderr = initResult.stderr?.toString().trim()
          const stdout = initResult.stdout?.toString().trim()
          throw new Error(stderr || stdout || `cap init exited with code ${initResult.status}`)
        }
        spinner.stop('Capacitor init done ✅')
        await saveAppIdToCapacitorConfig(appId)
        return
      }
      catch (error) {
        spinner.stop('Capacitor init failed ❌')
        throw error
      }
    }
  }

  await warnIfNotInCapacitorRoot()
}

async function selectPendingOnboardingApp(
  orgId: string,
  apikey: string,
  requestedAppId: string | undefined,
  pendingApps: PendingOnboardingApp[],
) {
  const requestedApp = requestedAppId
    ? pendingApps.find(app => app.app_id === requestedAppId)
    : undefined

  if (requestedApp) {
    const useRequestedApp = await pConfirm({
      message: `Use the pending onboarding app "${requestedApp.name || requestedApp.app_id}" (${requestedApp.app_id}) from the web console?`,
      initialValue: true,
    })
    await cancelCommand(useRequestedApp, orgId, apikey)
    return useRequestedApp ? requestedApp : undefined
  }

  if (pendingApps.length === 0) {
    return undefined
  }

  const selectedAppId = await pSelect({
    message: 'A pending onboarding app already exists in Capgo. What do you want to do?',
    options: [
      ...pendingApps.map(app => ({
        value: app.app_id,
        label: `${app.name || app.app_id} (${app.app_id})`,
        hint: app.existing_app ? 'Existing app' : 'New app created from web onboarding',
      })),
      { value: '__create_new__', label: 'Create a new app from the CLI' },
    ],
  })

  await cancelCommand(selectedAppId, orgId, apikey)

  if (selectedAppId === '__create_new__') {
    return undefined
  }

  return pendingApps.find(app => app.app_id === selectedAppId)
}

async function maybeReusePendingOnboardingApp(
  organization: Organization,
  apikey: string,
  appId: string | undefined,
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>,
  options?: Pick<SuperOptions, 'supaHost' | 'supaAnon'>,
) {
  const pendingApps = await listPendingOnboardingApps(supabase, organization.gid)
  const selectedApp = await selectPendingOnboardingApp(organization.gid, apikey, appId, pendingApps)

  if (!selectedApp) {
    return {
      appId,
      pendingApp: undefined,
      reusedPendingApp: false,
    }
  }

  const selectedAppId = selectedApp.app_id
  pLog.info(`Using pending onboarding app ${selectedAppId}`)

  if (findNearestCapacitorConfig(cwd())) {
    await syncPendingAppIdToCapacitorConfig(selectedAppId)
  }

  const cleanupSpinner = pSpinner()
  cleanupSpinner.start(`Preparing ${selectedAppId} for real onboarding`)
  try {
    await completePendingOnboardingApp(supabase, organization.gid, selectedAppId, apikey, {
      supaHost: options?.supaHost,
      supaAnon: options?.supaAnon,
    })
    cleanupSpinner.stop('Pending onboarding app prepared ✅')
  }
  catch (error) {
    cleanupSpinner.stop('Could not prepare pending onboarding app ❌')
    throw error
  }

  await markStep(organization.gid, apikey, 'add-app', selectedAppId)

  return {
    appId: selectedAppId,
    pendingApp: selectedApp,
    reusedPendingApp: true,
  }
}

async function selectOrganizationForInit(
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>,
  apikey: string,
): Promise<Organization> {
  const { allOrganizations, allowedOrganizations } = await getOrganizationListWithPermission(supabase, apikey, 'org.create_app')

  const organizationUidRaw = allowedOrganizations.length > 1
    ? await pSelect({
        message: 'Pick the organization that should own this app',
        options: allowedOrganizations.map((org) => {
          const twoFaWarning = (org.enforcing_2fa && !org['2fa_has_access']) ? '2FA required' : undefined
          return {
            value: org.gid,
            label: org.name,
            hint: twoFaWarning,
          }
        }),
      })
    : allowedOrganizations[0].gid

  if (pIsCancel(organizationUidRaw)) {
    pOutro('Bye 👋\n💡 You can resume the onboarding anytime by running the same command again')
    return await exitAfterFinishingReplay()
  }

  const organizationUid = organizationUidRaw as string
  const organization = allOrganizations.find(org => org.gid === organizationUid)

  if (!organization) {
    throw new Error('Selected organization not found')
  }

  if (organization.enforcing_2fa && !organization['2fa_has_access']) {
    pLog.error(`The organization "${organization.name}" requires all members to have 2FA enabled.`)
    pLog.error(`Enable 2FA at ${consoleWebUrl('/settings/account')} and try again.`)
    throw new Error('2FA required for selected organization')
  }

  pLog.info(`Using organization "${organization.name}" as the app owner`)
  return organization
}

async function checkPrerequisitesStep(orgId: string, apikey: string) {
  pLog.info(`📋 Checking development environment prerequisites`)
  pLog.info(`   For mobile development, you need at least one platform setup`)

  const hasXcode = platform === 'darwin' && existsSync('/Applications/Xcode.app')

  // Check for Android SDK in common locations
  const homeDir = env.HOME || env.USERPROFILE || '~'
  const androidPaths = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(homeDir, 'Library', 'Android', 'sdk'), // macOS
    join(homeDir, 'Android', 'Sdk'), // Windows/Linux
    join(homeDir, 'AppData', 'Local', 'Android', 'Sdk'), // Windows alternative
  ].filter(Boolean)

  const hasAndroidStudio = androidPaths.some(path => path && existsSync(path))

  if (hasXcode) {
    pLog.success(`✅ Xcode detected - iOS development ready`)
  }
  else if (platform === 'darwin') {
    pLog.warn(`⚠️  Xcode not found`)
  }

  if (hasAndroidStudio) {
    pLog.success(`✅ Android SDK detected - Android development ready`)
  }
  else {
    pLog.warn(`⚠️  Android SDK not found`)
  }

  if (!hasXcode && !hasAndroidStudio) {
    pLog.error(`❌ No development environment detected`)
    pLog.info(``)
    pLog.info(`📱 To develop mobile apps with Capacitor, you need:`)
    pLog.info(`   • For iOS: Xcode (macOS only) - https://developer.apple.com/xcode/`)
    pLog.info(`   • For Android: Android Studio - https://developer.android.com/studio`)
    pLog.info(``)

    const continueAnyway = await pConfirm({
      message: `Continue onboarding without a development environment? (You won't be able to build or test)`,
      initialValue: false,
    })
    await cancelCommand(continueAnyway, orgId, apikey)

    if (!continueAnyway) {
      pLog.info(`📝 Please install a development environment and run the onboarding again`)
      pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
      return await exitAfterFinishingReplay()
    }

    pLog.warn(`⚠️  Continuing without development environment - you'll need to set it up later`)
  }
  else if (!hasXcode && platform === 'darwin') {
    const wantsIos = await pConfirm({
      message: `Xcode is not installed. Do you plan to develop for iOS?`,
      initialValue: false,
    })
    await cancelCommand(wantsIos, orgId, apikey)

    if (wantsIos) {
      pLog.info(`📥 Please install Xcode from: https://developer.apple.com/xcode/`)
      pLog.info(`💡 After installing Xcode, you can continue the onboarding`)

      const installedNow = await pConfirm({
        message: `Have you installed Xcode? (Choose No to continue with Android only)`,
        initialValue: false,
      })
      await cancelCommand(installedNow, orgId, apikey)

      if (!installedNow) {
        pLog.info(`📱 Continuing with Android development only`)
      }
    }
  }
  else if (!hasAndroidStudio) {
    const wantsAndroid = await pConfirm({
      message: `Android SDK is not installed. Do you plan to develop for Android?`,
      initialValue: false,
    })
    await cancelCommand(wantsAndroid, orgId, apikey)

    if (wantsAndroid) {
      pLog.info(`📥 Please install Android Studio from: https://developer.android.com/studio`)
      pLog.info(`💡 After installing Android Studio, set up the Android SDK`)

      const installedNow = await pConfirm({
        message: `Have you installed Android Studio? (Choose No to continue with iOS only)`,
        initialValue: false,
      })
      await cancelCommand(installedNow, orgId, apikey)

      if (!installedNow) {
        pLog.info(`📱 Continuing with iOS development only`)
      }
    }
  }

  await markStep(orgId, apikey, 'check-prerequisites', 'checked')
}

type ExistingAppConflictResolution = 'use-existing' | 'recreate' | 'choose-different' | 'not-owned'

async function completeExistingAppPendingOnboarding(
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>,
  organization: Organization,
  appId: string,
  apikey: string,
  options?: Pick<SuperOptions, 'supaHost' | 'supaAnon'>,
) {
  const s = pSpinner()
  s.start(`Preparing existing app ${appId}`)
  try {
    await completePendingOnboardingApp(supabase, organization.gid, appId, apikey, {
      supaHost: options?.supaHost,
      supaAnon: options?.supaAnon,
    })
    s.stop('Existing app prepared ✅')
  }
  catch (error) {
    s.stop('Could not prepare existing app ❌')
    throw error
  }
}

async function resolveExistingAppConflict(
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>,
  organization: Organization,
  apikey: string,
  appId: string,
  options: SuperOptions,
): Promise<ExistingAppConflictResolution> {
  const existingApp: ExistingOrganizationApp | null = await findAppInOrganization(supabase, organization.gid, appId)
  if (!existingApp)
    return 'not-owned'

  pLog.warn(`App ID "${appId}" already exists in "${organization.name}".`)
  if (existingApp.name?.trim())
    pLog.info(`Found existing app "${existingApp.name}" in your Capgo account.`)

  const useExistingApp = await pConfirm({
    message: 'You already created this app. Do you want to use it?',
    initialValue: true,
  })
  await cancelCommand(useExistingApp, organization.gid, apikey)

  if (useExistingApp === true) {
    if (existingApp.need_onboarding)
      await completeExistingAppPendingOnboarding(supabase, organization, appId, apikey, options)

    await saveAppIdToCapacitorConfig(appId)
    return 'use-existing'
  }

  const deleteExistingApp = await pConfirm({
    message: 'Do you want to delete it to recreate it again?',
    initialValue: false,
  })
  await cancelCommand(deleteExistingApp, organization.gid, apikey)

  if (deleteExistingApp === true) {
    const s = pSpinner()
    s.start(`Deleting existing app ${appId}`)
    try {
      await deleteAppInternal(appId, { ...options, apikey }, true, true)
      s.stop('Existing app deleted ✅')
    }
    catch (error) {
      s.stop('Could not delete existing app ❌')
      pLog.warn(`Could not delete the existing app: ${formatError(error)}`)
      return 'choose-different'
    }

    return 'recreate'
  }

  return 'choose-different'
}

async function askForReplacementAppId(
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>,
  organization: Organization,
  apikey: string,
  baseAppId: string,
): Promise<string> {
  const rawSuggestions = buildAppIdConflictSuggestions(baseAppId)
  const existingResults = await checkAppIdsExist(supabase, rawSuggestions)
  const suggestions = rawSuggestions.filter((_, idx) => !existingResults[idx].exists).slice(0, 4)

  if (suggestions.length === 0) {
    pLog.warn('No available suggestions found. Please enter a custom app ID.')
    return askForAppId('Enter your custom app ID (e.g., com.example.myapp):')
  }

  pLog.info('💡 Here are some available suggestions:')
  suggestions.forEach((suggestion, idx) => {
    pLog.info(`   ${idx + 1}. ${suggestion}`)
  })

  const choice = await pSelect({
    message: 'What would you like to do?',
    options: [
      ...suggestions.map((suggestion, idx) => ({
        value: `suggest-${idx}`,
        label: `Use ${suggestion}`,
      })),
      { value: 'custom', label: 'Enter a custom app ID' },
      { value: 'cancel', label: 'Cancel onboarding' },
    ],
  })

  await cancelCommand(choice, organization.gid, apikey)

  if (choice === 'cancel') {
    await markInitSnag(organization.gid, apikey, 'canceled-appid-conflict', undefined, '🤷')
    pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
    return await exitAfterFinishingReplay()
  }

  if (choice === 'custom')
    return askForAppId('Enter your custom app ID (e.g., com.example.myapp):')

  const suggestionIndex = Number.parseInt((choice as string).replace('suggest-', ''), 10)
  return suggestions[suggestionIndex]
}

async function addAppStep(organization: Organization, apikey: string, appId: string, options: SuperOptions): Promise<string> {
  const pm = getPMAndCommand()
  let currentAppId = appId
  let confirmedAppId: string | undefined

  while (true) {
    if (confirmedAppId !== currentAppId) {
      const addChoice = await pSelect({
        message: `Add ${currentAppId} to Capgo?`,
        options: [
          { value: 'yes', label: '✅ Yes, add it' },
          { value: 'change', label: '❌ No, use a different app ID' },
        ],
      })
      await cancelCommand(addChoice, organization.gid, apikey)

      if (addChoice === 'change') {
        currentAppId = await askForAppId('Enter the correct app ID (e.g., com.example.app):')
        confirmedAppId = undefined
        continue
      }

      confirmedAppId = currentAppId
    }

    try {
      const s = pSpinner()
      s.start(`Running: ${pm.runner} @capgo/cli@latest app add ${currentAppId}`)
      try {
        await addAppInternal(currentAppId, options, organization, true, 'onboarding')
        await saveAppIdToCapacitorConfig(currentAppId)
      }
      catch (innerError) {
        s.stop(`App add failed ❌`)
        throw innerError
      }

      await markStep(organization.gid, apikey, 'add-app', currentAppId)
      return currentAppId
    }
    catch (error) {
      if (isAppAlreadyExistsError(error)) {
        const supabase = await createSupabaseClient(options.apikey ?? apikey, options.supaHost, options.supaAnon)

        const conflictResolution = await resolveExistingAppConflict(supabase, organization, apikey, currentAppId, options)
        if (conflictResolution === 'use-existing') {
          await markStep(organization.gid, apikey, 'add-app', currentAppId)
          return currentAppId
        }

        if (conflictResolution === 'recreate') {
          confirmedAppId = currentAppId
          continue
        }

        if (conflictResolution === 'not-owned')
          pLog.error(`❌ App ID "${currentAppId}" is already taken`)

        currentAppId = await askForReplacementAppId(supabase, organization, apikey, currentAppId)
        confirmedAppId = undefined
        pLog.info(`🔄 Trying with new app ID: ${currentAppId}`)
        continue
      }

      // For other errors, re-throw
      throw error
    }
  }
}

async function addChannelStep(orgId: string, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  pLog.success(`✅ App ${appId} added — accessible to all members of your organization`)
  pLog.info(`💡 A channel is a release track — it controls which users get which updates.`)
  pLog.info(`   Nothing goes live until you release a native build with Capacitor Updater to the stores.`)
  pLog.info(`   Most apps just need one: "production". You can add more later.`)
  pLog.info(`   Learn more: https://capgo.app/docs/live-updates/channels/`)
  let channelName = globalChannelName
  const channelChoice = await pSelect({
    message: 'Which channel name do you want to use?',
    options: [
      { value: 'default', label: `✅ Use "${defaultChannel}"` },
      { value: 'custom', label: '✏️ Choose a custom name' },
    ],
  })
  await cancelCommand(channelChoice, orgId, apikey)

  if (channelChoice === 'custom') {
    const selectedChannelName = await pText({
      message: 'Enter the channel name to use for onboarding:',
      placeholder: 'e.g. staging, beta, dev',
      validate: validateChannelName,
    })
    await cancelCommand(selectedChannelName, orgId, apikey)
    channelName = (selectedChannelName as string).trim()
  }

  globalChannelName = channelName
  const s = pSpinner()
  s.start(`Running: ${pm.runner} @capgo/cli@latest channel add ${channelName} ${appId} --default`)
  try {
    const addChannelRes = await addChannelInternal(channelName, appId, {
      default: true,
      apikey,
    }, true)
    if (!addChannelRes)
      s.stop(`Channel already added ✅`)
    else
      s.stop(`Channel add done ✅`)
  }
  catch (error) {
    s.stop(`Channel creation failed ❌`)
    throw error
  }
  await markStep(orgId, apikey, 'add-channel', appId)
  return channelName
}

function rememberPackageJsonPath(packageJsonPath: string): void {
  globalPathToPackageJson = packageJsonPath
}

async function cancelPackageJsonSelection(command: boolean | string | symbol): Promise<void> {
  if (pIsCancel(command)) {
    pCancel('Operation cancelled.')
    return await exitAfterFinishingReplay(1)
  }
}

function validatePackageJsonPath(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim()
  if (!trimmedValue)
    return 'Path is required.'
  if (!existsSync(trimmedValue))
    return `Path ${trimmedValue} does not exist`
  if (path.basename(trimmedValue) !== PACKNAME)
    return 'Selected a file that is not a package.json file'
}

async function selectPackageJsonFromTree(): Promise<string> {
  let currentPath = cwd()
  let selectedEntry = PACKNAME as string | symbol
  while (true) {
    const options = readdirSync(currentPath)
      .map(dir => ({ value: dir, label: dir }))
    options.push({ value: '..', label: '..' })
    selectedEntry = await pSelect({
      message: 'Select package.json file:',
      options,
    })
    await cancelPackageJsonSelection(selectedEntry)
    if (typeof selectedEntry !== 'string')
      continue

    if (!statSync(join(currentPath, selectedEntry)).isDirectory() && selectedEntry !== PACKNAME) {
      pLog.error(`Selected a file that is not a package.json file`)
      continue
    }
    currentPath = join(currentPath, selectedEntry)
    if (selectedEntry === PACKNAME)
      return currentPath
  }
}

async function promptForPackageJsonPath(): Promise<string> {
  const packageJsonPath = await pText({
    message: 'Enter path to package.json file:',
    validate: validatePackageJsonPath,
  }) as string
  await cancelPackageJsonSelection(packageJsonPath)
  return packageJsonPath.trim()
}

async function resolvePackageJsonPath(): Promise<string | null> {
  const doSelect = await pConfirm({ message: 'Would you like to select the package.json file manually?' })
  await cancelPackageJsonSelection(doSelect)
  if (!doSelect)
    return null

  const useNativePicker = canUseFilePicker()
  if (useNativePicker) {
    const selectedPath = await openPackageJsonPicker()
    if (selectedPath) {
      const validationError = validatePackageJsonPath(selectedPath)
      if (!validationError)
        return selectedPath
      pLog.error(validationError)
    }

    pLog.info('Falling back to manual path entry.')
  }

  if (!useNativePicker) {
    const useTreeSelect = await pConfirm({ message: 'Would you like to use a tree selector to choose the package.json file?' })
    await cancelPackageJsonSelection(useTreeSelect)
    if (useTreeSelect)
      return selectPackageJsonFromTree()
  }

  return promptForPackageJsonPath()
}

async function getAssistedDependencies() {
  // here we will assume that getAllPackagesDependencies uses 'findRoot(cwd())' for the first argument
  const root = join(findRoot(cwd()), PACKNAME)
  let packageJsonPath = globalPathToPackageJson ?? root
  let dependencies = await getAllPackagesDependencies(undefined, packageJsonPath)
  if (dependencies.size === 0 || !dependencies.has('@capacitor/core')) {
    pLog.warn('No adequate dependencies found')
    const selectedPackageJsonPath = await resolvePackageJsonPath()
    if (selectedPackageJsonPath) {
      packageJsonPath = selectedPackageJsonPath
      dependencies = await getAllPackagesDependencies(undefined, packageJsonPath)
    }
  }

  // even in the default case, remember the path to package.json
  // this will help with bundle upload
  rememberPackageJsonPath(packageJsonPath)
  return { dependencies, path: packageJsonPath }
}

const urlMigrateV5 = 'https://capacitorjs.com/docs/updating/5-0'
const urlMigrateV6 = 'https://capacitorjs.com/docs/updating/6-0'
const urlMigrateV7 = 'https://capacitorjs.com/docs/updating/7-0'
const urlMigrateV8 = 'https://capacitorjs.com/docs/updating/8-0'

function getUpdaterInstallBlocker(dependencies: Map<string, string>, packageManager: ReturnType<typeof getPMAndCommand>): string | undefined {
  if (!dependencies.has('@capacitor/core'))
    return 'Cannot find @capacitor/core in package.json.'

  const coreVersion = dependencies.get('@capacitor/core')
  if (!coreVersion)
    return 'Cannot determine the installed @capacitor/core version.'
  const normalizedCoreVersion = normalizeConcreteVersion(coreVersion)
  if (!normalizedCoreVersion)
    return `Cannot parse @capacitor/core version "${coreVersion}". Pin a concrete semver version before continuing.`
  if (lessThan(parse(normalizedCoreVersion), parse('5.0.0')))
    return `@capacitor/core version is ${normalizedCoreVersion}. Capgo requires Capacitor v5 or newer. Migration guide: ${urlMigrateV5}`
  if (packageManager.pm === 'unknown')
    return 'Cannot recognize the package manager for this project. Use bun, pnpm, yarn, or npm in a Capacitor project root.'

  return undefined
}

function getUpdaterVersionToInstall(coreVersion: string, logSelection = true): { versionToInstall: string, shouldOfferDirectInstall: boolean } {
  if (lessThan(parse(coreVersion), parse('6.0.0'))) {
    if (logSelection) {
      pLog.info(`@capacitor/core version is ${coreVersion}, installing compatible capacitor-updater v5`)
      pLog.warn(`Consider upgrading to Capacitor v6 or higher to support the latest mobile OS features: ${urlMigrateV6}`)
    }
    return { versionToInstall: '^5.0.0', shouldOfferDirectInstall: false }
  }
  if (lessThan(parse(coreVersion), parse('7.0.0'))) {
    if (logSelection) {
      pLog.info(`@capacitor/core version is ${coreVersion}, installing compatible capacitor-updater v6`)
      pLog.warn(`Consider upgrading to Capacitor v7 or higher to support the latest mobile OS features: ${urlMigrateV7}`)
    }
    return { versionToInstall: '^6.0.0', shouldOfferDirectInstall: false }
  }
  if (lessThan(parse(coreVersion), parse('8.0.0'))) {
    if (logSelection) {
      pLog.info(`@capacitor/core version is ${coreVersion}, installing compatible capacitor-updater v7`)
      pLog.warn(`Consider upgrading to Capacitor v8 to support the latest mobile OS features: ${urlMigrateV8}`)
    }
    return { versionToInstall: '^7.0.0', shouldOfferDirectInstall: false }
  }

  if (logSelection)
    pLog.info(`@capacitor/core version is ${coreVersion}, installing latest capacitor-updater`)
  return { versionToInstall: 'latest', shouldOfferDirectInstall: true }
}

function getUpdaterInstallCommand(pm: PackageManagerInfo, versionToInstall: string, force = false): string {
  const forceFlag = force ? ' --force' : ''
  return `${pm.installCommand}${forceFlag} ${CAPGO_UPDATER_PACKAGE}@${versionToInstall}`
}

function formatSpawnOutput(output: string | Buffer | null | undefined): string {
  if (!output)
    return ''
  return typeof output === 'string' ? output : output.toString('utf8')
}

function runUpdaterInstallCommand(pm: PackageManagerInfo, packageJsonPath: string, versionToInstall: string): void {
  const [command, ...args] = pm.installCommand.split(whitespaceSplitPattern).filter(Boolean)
  if (!command)
    throw new Error('Cannot determine package manager install command')

  const result = spawnSync(command, [...args, '--force', `${CAPGO_UPDATER_PACKAGE}@${versionToInstall}`], {
    stdio: 'pipe',
    cwd: dirname(packageJsonPath),
  })
  if (result.error || result.status !== 0) {
    const output = [formatSpawnOutput(result.stdout), formatSpawnOutput(result.stderr)]
      .map(text => text.trim())
      .filter(Boolean)
      .join('\n')
    const outputDetails = output ? `\n${output}` : ''
    const message = `Updater install failed with code ${result.status ?? 'unknown'}${outputDetails}`
    throw result.error ?? new Error(message)
  }
}

function logUpdaterInstallStateDetails(packageJsonPath: string, details: string[], manualCommand: string): void {
  pLog.warn(`${CAPGO_UPDATER_PACKAGE} is not ready yet.`)
  for (const detail of details) {
    pLog.warn(detail)
  }
  pLog.info(`Run this in ${dirname(packageJsonPath)}: ${manualCommand}`)
}

async function waitForVerifiedUpdaterInstall(
  orgId: string,
  apikey: string,
  packageJsonPath: string,
  pm: PackageManagerInfo,
  versionToInstall: string,
  options: { allowAutoRetry?: boolean, failureText?: string, supportPlatform?: PlatformChoice } = {},
) {
  const manualCommand = getUpdaterInstallCommand(pm, versionToInstall)

  while (true) {
    const state = getUpdaterInstallState(packageJsonPath)
    if (state.ready) {
      pLog.info(`${CAPGO_UPDATER_PACKAGE} found in package.json and node_modules ✅`)
      return state
    }

    logUpdaterInstallStateDetails(packageJsonPath, state.details, manualCommand)

    if (options.allowAutoRetry) {
      const recoveryChoice = await selectRecoveryOption(orgId, apikey, 'Updater install is not complete yet. What do you want to do?', [
        { value: 'retry-auto', label: 'Retry automatic updater install' },
        { value: 'manual', label: 'Install it manually, then continue' },
      ], options.failureText ?? state.details.join('\n'), options.supportPlatform)
      if (recoveryChoice === 'retry-auto') {
        const s = pSpinner()
        try {
          s.start(`Running: ${getUpdaterInstallCommand(pm, versionToInstall, true)}`)
          runUpdaterInstallCommand(pm, packageJsonPath, versionToInstall)
          s.stop('Updater install command finished ✅')
        }
        catch (error) {
          s.stop('Updater install failed ❌')
          pLog.error(formatError(error))
        }
        continue
      }
    }

    await waitForReadyConfirmation(
      `Install ${CAPGO_UPDATER_PACKAGE} manually, then come back here.`,
      orgId,
      apikey,
      `Type "ready" when ${CAPGO_UPDATER_PACKAGE} is installed.`,
    )
  }
}

async function addUpdaterStep(orgId: string, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  let pkgVersion = '1.0.0'
  let delta = false
  const installChoice = await pSelect({
    message: `Install @capgo/capacitor-updater in your project?`,
    options: [
      { value: 'yes', label: '✅ Yes, install it' },
      { value: 'no', label: '❌ No, I\'ll do it manually' },
    ],
  })
  await cancelCommand(installChoice, orgId, apikey)

  while (true) {
    const { dependencies, path } = await getAssistedDependencies()
    const blocker = getUpdaterInstallBlocker(dependencies, pm)
    if (blocker) {
      pLog.warn(blocker)
      await selectRecoveryOption(orgId, apikey, 'Fix the project, then choose what to do next.', [
        { value: 'retry', label: 'Retry updater checks' },
      ], blocker)
      continue
    }

    const coreVersion = normalizeConcreteVersion(dependencies.get('@capacitor/core'))!
    const { versionToInstall, shouldOfferDirectInstall } = getUpdaterVersionToInstall(coreVersion)
    pkgVersion = getBundleVersion(undefined, path) || pkgVersion

    if (installChoice === 'yes') {
      const s = pSpinner()
      s.start(`Checking if ${CAPGO_UPDATER_PACKAGE} is installed`)
      const installState = getUpdaterInstallState(path)

      if (installState.ready) {
        s.stop(`Capgo already installed ✅`)
      }
      else {
        try {
          runUpdaterInstallCommand(pm, path, versionToInstall)
          s.stop(`Install Done ✅`)
        }
        catch (error) {
          s.stop('Updater install failed ❌')
          pLog.error(formatError(error))
        }
      }
    }
    else {
      pLog.info(`Install it manually with: "${getUpdaterInstallCommand(pm, versionToInstall)}"`)
    }

    await waitForVerifiedUpdaterInstall(orgId, apikey, path, pm, versionToInstall, {
      allowAutoRetry: installChoice === 'yes',
    })

    let doDirectInstall: boolean | symbol = false
    if (shouldOfferDirectInstall) {
      doDirectInstall = await pConfirm({ message: `Do you want to set instant updates in ${appId}? Read more about it here: https://capgo.app/docs/live-updates/update-behavior/#applying-updates-immediately` })
      await cancelCommand(doDirectInstall, orgId, apikey)
    }

    const s = pSpinner()
    s.start(`Updating config file`)
    delta = !!doDirectInstall
    const projectDir = dirname(path)
    await withTemporaryCwd(getInitConfigLoadDir(projectDir), async () => {
      if (doDirectInstall) {
        await updateConfigbyKey('SplashScreen', { launchAutoHide: false })
      }
      await updateConfigUpdater(getInitUpdaterPluginConfig(appId, delta))
    })
    s.stop(`Config file updated ✅`)
    break
  }

  await markStep(orgId, apikey, 'add-updater', appId)
  return { pkgVersion, delta }
}

async function addCodeStep(orgId: string, apikey: string, appId: string) {
  const addCodeChoice = await pSelect({
    message: `Add the Capacitor Updater import to your main file?`,
    options: [
      { value: 'yes', label: '✅ Yes, add it' },
      { value: 'no', label: '❌ No, I\'ll do it manually' },
    ],
  })
  await cancelCommand(addCodeChoice, orgId, apikey)

  if (addCodeChoice === 'yes') {
    const s = pSpinner()
    s.start(`Adding @capacitor-updater to your main file`)

    const packageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
    const projectDir = dirname(packageJsonPath)
    const resolveProjectFilePath = (filePath: string) => path.isAbsolute(filePath) ? filePath : join(projectDir, filePath)
    const projectType = await findProjectType({ quiet: true, packageJsonPath })
    if (!globalMainFilePath && (projectType === 'nuxtjs-js' || projectType === 'nuxtjs-ts')) {
      // Nuxt.js specific logic
      const nuxtDir = join(projectDir, 'plugins')
      if (!existsSync(nuxtDir)) {
        mkdirSync(nuxtDir, { recursive: true })
      }
      let nuxtFilePath
      if (projectType === 'nuxtjs-ts') {
        nuxtFilePath = join(nuxtDir, 'capacitorUpdater.client.ts')
      }
      else {
        nuxtFilePath = join(nuxtDir, 'capacitorUpdater.client.js')
      }
      const nuxtFileLines = [
        `import { CapacitorUpdater } from '@capgo/capacitor-updater'`,
        ``,
        `export default defineNuxtPlugin(() => {`,
        `  CapacitorUpdater.notifyAppReady()`,
        `})`,
        ``,
      ]
      const nuxtFileContent = nuxtFileLines.join('\n')
      const nuxtDisplayPath = formatInitFilePath(nuxtFilePath)
      if (existsSync(nuxtFilePath)) {
        const currentContent = readFileSync(nuxtFilePath, 'utf8')
        if (currentContent.includes('CapacitorUpdater.notifyAppReady()')) {
          s.stop()
          globalCodeDiff = {
            filePath: nuxtDisplayPath,
            created: false,
            lines: [],
            note: 'Already contains CapacitorUpdater.notifyAppReady() — no change needed',
          }
        }
        else {
          writeFileSync(nuxtFilePath, nuxtFileContent, 'utf8')
          s.stop()
          globalCodeDiff = {
            filePath: nuxtDisplayPath,
            created: false,
            lines: buildCodeDiffLines(currentContent, nuxtFileContent, CODE_DIFF_CONTEXT_LINES),
          }
        }
      }
      else {
        writeFileSync(nuxtFilePath, nuxtFileContent, 'utf8')
        s.stop()
        globalCodeDiff = {
          filePath: nuxtDisplayPath,
          created: true,
          lines: buildCodeDiffLines('', nuxtFileContent, CODE_DIFF_CONTEXT_LINES),
        }
      }
      setInitCodeDiff(globalCodeDiff)
    }
    else {
      // Handle other project types
      let mainFilePath: string | null = globalMainFilePath ?? null
      if (!mainFilePath && projectType === 'unknown') {
        mainFilePath = await findMainFile(true, projectDir)
      }
      else if (!mainFilePath) {
        const isTypeScript = projectType.endsWith('-ts')
        const projectTypeMainFile = findMainFileForProjectType(projectType, isTypeScript, projectDir)
        mainFilePath = projectTypeMainFile ? resolveProjectFilePath(projectTypeMainFile) : projectTypeMainFile
      }

      // Open main file and inject codeInject
      if (!mainFilePath || !existsSync(mainFilePath)) {
        s.stop('Cannot find main file to install Updater plugin', 'neutral')
        const userProvidedPath = await pText({
          message: `Provide the correct relative path to your main file (JS or TS):`,
          validate: (value) => {
            if (!value || !existsSync(resolveProjectFilePath(value)))
              return 'File does not exist. Please provide a valid path.'
          },
        })
        if (pIsCancel(userProvidedPath)) {
          pCancel('Operation cancelled.')
          return await exitAfterFinishingReplay(1)
        }
        mainFilePath = resolveProjectFilePath(userProvidedPath as string)
      }
      const mainFile = readFileSync(mainFilePath, 'utf8')
      const mainFileContent = mainFile.toString()
      const matches = mainFileContent.match(regexImport)
      const last = matches?.pop()

      if (!last) {
        s.stop('Cannot auto-inject code', 'neutral')
        pLog.warn(`❌ Cannot find import statements in ${mainFilePath}`)
        pLog.info(`💡 You'll need to add the code manually`)
        pLog.info(`📝 Add this to your main file:`)
        pLog.info(`   ${importInject}`)
        pLog.info(`   ${codeInject}`)
        pLog.info(`📚 Or follow: https://capgo.app/docs/getting-started/add-an-app/`)

        const continueAnyway = await pConfirm({
          message: `Continue without auto-injecting the code? (You'll add it manually)`,
        })
        await cancelCommand(continueAnyway, orgId, apikey)

        if (!continueAnyway) {
          pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
          return await exitAfterFinishingReplay()
        }

        pLog.info(`⏭️  Skipping auto-injection - remember to add the code manually!`)
        await markStep(orgId, apikey, 'add-code-manual', appId)
      }
      else if (mainFileContent.includes(codeInject)) {
        s.stop()
        globalCodeDiff = {
          filePath: formatInitFilePath(mainFilePath),
          created: false,
          lines: [],
          note: 'Already contains CapacitorUpdater.notifyAppReady() — no change needed',
        }
        setInitCodeDiff(globalCodeDiff)
      }
      else {
        // Note: no trailing `\n` — the original file already has newlines after
        // `last`, so adding one here would create a spurious blank line that
        // shows up as an added `+` line in the diff panel.
        const newMainFileContent = mainFileContent.replace(last, `${last}\n${importInject};\n\n${codeInject};`)
        writeFileSync(mainFilePath, newMainFileContent, 'utf8')
        s.stop()
        globalCodeDiff = {
          filePath: formatInitFilePath(mainFilePath),
          created: false,
          lines: buildCodeDiffLines(mainFileContent, newMainFileContent, CODE_DIFF_CONTEXT_LINES),
        }
        setInitCodeDiff(globalCodeDiff)
      }
    }

    await markStep(orgId, apikey, 'add-code', appId)
  }
  else {
    pLog.info(`Add to your main file the following code:\n\n${importInject};\n\n${codeInject};\n`)
  }
}

async function addEncryptionStep(orgId: string, apikey: string, appId: string) {
  if (globalCodeDiff) {
    setInitCodeDiff(globalCodeDiff)
  }
  const packageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
  const projectDir = dirname(packageJsonPath)
  const dependencies = await getAllPackagesDependencies(undefined, packageJsonPath)
  const coreVersion = dependencies.get('@capacitor/core')
  const normalizedCoreVersion = normalizeConcreteVersion(coreVersion)
  if (!coreVersion) {
    pLog.warn(`Cannot find @capacitor/core in package.json. It is likely that you are using a monorepo. Please NOTE that encryption is not supported in Capacitor V5.`)
  }

  const pm = getPMAndCommand()

  // Ask up-front whether the app is security-critical, with an extra option
  // for users who don't know what encryption is. The "learn more" branch
  // prints a short overview, optionally opens the docs in a browser, then
  // loops back to this same prompt.
  const encryptionDocsUrl = 'https://capgo.app/docs/live-updates/encryption/'
  type EncryptionChoice = 'critical' | 'not_needed' | 'learn'
  let isSecurityCritical = false
  let learnShown = false
  while (true) {
    // Option order matters: the first option is highlighted by default in
    // `@inkjs/ui` Select, so pressing Enter resolves to it. The previous
    // `pConfirm` for this question defaulted to `false` ("no"), so keep the
    // safe "not needed" path as the default here to avoid users accidentally
    // entering the key-creation flow by hammering Enter. Drop the "learn more"
    // option once the user has already seen the overview — re-offering it
    // makes no sense and clutters the decision.
    const options: { value: EncryptionChoice, label: string }[] = [
      { value: 'not_needed', label: '❌ No, my app doesn\'t need this' },
      { value: 'critical', label: '🔐 Yes — set up end-to-end encryption' },
    ]
    if (!learnShown)
      options.push({ value: 'learn', label: '❓ What is encryption? (learn more)' })

    const choice = await pSelect<EncryptionChoice>({
      message: `Is ${appId} a security-critical app, like banking, regulated, or sensitive-data handling?`,
      options,
    })
    await cancelCommand(choice, orgId, apikey)

    // The code diff panel from step 4 has served its purpose the moment the
    // user answers this first question — clear it immediately (before any
    // follow-up logging or prompts) so both the learn-more overview and the
    // direct yes/no paths render against the full viewport.
    if (globalCodeDiff) {
      globalCodeDiff = undefined
      setInitCodeDiff(undefined)
    }

    if (choice === 'learn') {
      learnShown = true
      pLog.info(`🔐 End-to-end encryption in Capgo (fast overview):`)
      pLog.info(`   • Capgo bundles are plain web assets (JS / HTML / CSS) served over HTTPS.`)
      pLog.info(`   • Without encryption, anyone who obtains a bundle URL can download and read them.`)
      pLog.info(`   • Capgo's encryption uses a hybrid RSA + AES scheme:`)
      pLog.info(`       – A random AES session key encrypts the bundle contents.`)
      pLog.info(`       – Your RSA private key encrypts that AES key and signs a checksum.`)
      pLog.info(`       – The public RSA key shipped in your app decrypts + verifies it.`)
      pLog.info(`   • True end-to-end: the private key lives only on your machine, so not even`)
      pLog.info(`     Capgo can read the bundle contents.`)
      pLog.info(`   • Requires Capacitor v6+. Debugging update failures is slightly harder once enabled.`)
      pLog.info(`   • Recommended for banking, healthcare, regulated, or sensitive-data apps.`)
      pLog.info(`     Most other apps do not need it.`)
      // Always surface the docs URL so the user can copy it later, even if
      // they decline to open a browser right now. The leading newline inside
      // the same message inserts a visual blank row — Ink collapses entries
      // whose message is just an empty string, so we cannot push a separate
      // blank log entry.
      pLog.info(`\n   📖 Full docs: ${encryptionDocsUrl}`)

      const openDocs = await pConfirm({
        message: `Open the full encryption docs in your browser now?`,
        initialValue: false,
      })
      await cancelCommand(openDocs, orgId, apikey)
      if (openDocs) {
        try {
          await open(encryptionDocsUrl)
          pLog.info(`   🌐 Opened ${encryptionDocsUrl}`)
        }
        catch {
          pLog.warn(`Could not open your browser automatically. Visit: ${encryptionDocsUrl}`)
        }
      }
      continue
    }

    isSecurityCritical = choice === 'critical'
    break
  }

  // The final outcome of this step is captured as a persistent summary panel
  // (mirroring the code-diff panel from step 4) so it survives the transition
  // to the next step instead of flashing by when logs get cleared. We build
  // it in a local variable and only push it to the runtime after the step's
  // work is done — this avoids rendering a premature "enabled" panel while
  // key creation is still running, and lets the key-failure branch downgrade
  // it to a "not enabled" summary.
  // Two-phase "enabled" state. Right after key creation the keys exist
  // locally and the public key is in `capacitor.config.*`, but the native
  // project has NOT been synced yet — encrypted updates would fail. We
  // only flip to the fully-enabled summary once `buildProjectStep` has
  // run `cap sync` successfully. See `maybePromoteEncryptionSummary`.
  const pendingSyncSummary: InitEncryptionSummary = {
    phase: 'pending-sync',
    title: '🔐 Encryption keys generated — awaiting cap sync',
    lines: [
      '   • Private RSA key saved locally (.capgo_key_v2) — do not commit it.',
      '   • Public RSA key written to capacitor.config — not bundled in the native app yet.',
      '   • Encrypted updates will FAIL until the native project is synced.',
      `   • Step 7 runs "${pm.runner} cap sync" automatically, which bundles the key.`,
    ],
  }
  const skippedSummary: InitEncryptionSummary = {
    phase: 'skipped',
    title: '⏭️  Encryption SKIPPED',
    lines: [
      '   • Bundles are plain JS / HTML / CSS, fetchable by anyone who finds the URL.',
      '   • Never put private API keys or backend secrets in a mobile app.',
      `   • You can enable encryption later with: ${pm.runner} @capgo/cli@latest key create`,
    ],
  }
  let finalSummary: InitEncryptionSummary = skippedSummary

  // Q1 already phrases the "yes" branch as "set up end-to-end encryption",
  // so there's no second confirmation to ask — a critical answer goes
  // straight into key creation.
  if (isSecurityCritical) {
    if (coreVersion && !normalizedCoreVersion) {
      pLog.error(`Cannot parse @capacitor/core version "${coreVersion}". Pin a concrete semver version before enabling encryption.`)
      return
    }
    if (normalizedCoreVersion && lessThan(parse(normalizedCoreVersion), parse('6.0.0'))) {
      pLog.warn(`Encryption is not supported in Capacitor V5.`)
      return
    }

    const s = pSpinner()
    s.start(`Creating RSA encryption keys`)
    // Silent mode is critical here: non-silent createKeyInternal calls
    // clack's `intro()`, `log.*`, and `pConfirm` directly, which write to
    // stdout and collide with the ink render loop (the same whack-a-mole
    // gating issue from PR #560 / #579). It also runs
    // `promptAndSyncCapacitor({ validateIosUpdater: true })` which uses
    // its own clack spinners and a blocking confirm — we want full
    // control over the sync UI here, so we run `cap sync` ourselves in
    // the full-screen streaming panel immediately after.
    // setupChannel=false avoids a rogue clack confirm when an old private
    // key is present in the config.
    try {
      const encryptionConfig = await withTemporaryCwd(getInitConfigLoadDir(projectDir), () => getConfigForWrite())
      await withTemporaryCwd(projectDir, () => createKeyInternal({ force: true, setupChannel: false }, true, encryptionConfig))
      // Intentionally stop without a success message: the persistent
      // encryption summary panel renders on the next step and already shows
      // the outcome. Passing a message here would push it into the rolling
      // log buffer, which `renderInitOnboardingFrame` wipes when step 6
      // renders — producing a visible "flash" of the success line.
      s.stop()
      await markInitSnag(orgId, apikey, 'Use encryption v2', appId)

      // Run `cap sync` now, inside step 5, so the public key we just wrote
      // to `capacitor.config.*` actually lands in the native projects
      // before we claim "Encryption ENABLED". The streaming panel takes
      // over the whole viewport while the sync runs (mirrors the
      // `capgo build` onboarding log streamer) — this is the only way to
      // honestly mark encryption enabled without waiting for step 7.
      //
      // Platform is not passed because the user hasn't picked one yet
      // (that happens in step 6). `cap sync` without a platform syncs
      // every native platform that's already been `cap add`-ed, which is
      // exactly what we want — the key needs to end up in whichever
      // native projects exist.
      await ensureUpdaterReadyBeforeSync(pm, orgId, apikey, packageJsonPath)
      const syncResult = await streamCommandInInitPanel({
        title: '🔐 Syncing native project so the public key is bundled',
        runner: pm.runner,
        args: ['cap', 'sync'],
        cwd: projectDir,
      })
      // Small dwell so the user can read the final state of the panel
      // (success banner or the last few lines of an error) before we
      // tear it down and move on.
      await delay(3500)
      clearInitStreamingOutput()

      if (syncResult.success) {
        finalSummary = {
          phase: 'enabled',
          title: '🔐 Encryption ENABLED',
          lines: [
            '   • Private RSA key stays on your machine — do not commit it.',
            '   • Public RSA key is bundled in the app (extractable by reverse engineering).',
            '   • Bundles encrypted with a random AES key, key wrapped with your RSA key.',
            '   • Bundle checksum is signed with your RSA key so the app can verify integrity.',
          ],
        }
      }
      else {
        // Keys exist on disk and in the config, but `cap sync` failed, so
        // the native project doesn't have the new key yet. Fall back to
        // pending-sync — step 7's build & sync will retry and, on
        // success, `promoteEncryptionSummaryToEnabled` will flip it.
        pLog.warn(`cap sync failed: ${syncResult.error?.message ?? 'unknown error'}`)
        pLog.warn('Encryption keys were generated but the native project has not been synced yet.')
        pLog.info('Step 7 will run the build and cap sync again — if that succeeds, encryption becomes fully active.')
        finalSummary = pendingSyncSummary
      }
    }
    catch (error) {
      s.stop('Error', 'error')
      const failureText = error instanceof Error ? error.message : String(error)
      pLog.warn(`Cannot create key ❌ ${failureText}`)
      const recoveryChoice = await selectRecoveryOption(orgId, apikey, 'Encryption key creation failed. What do you want to do?', [
        { value: 'retry', label: 'Retry key creation' },
        { value: 'skip', label: 'Continue without encryption' },
      ], failureText)

      if (recoveryChoice === 'retry') {
        return addEncryptionStep(orgId, apikey, appId)
      }

      finalSummary = {
        phase: 'failed',
        title: '⚠️  Encryption NOT ENABLED (key creation failed)',
        lines: [
          '   • Key creation failed and you chose to continue without encryption.',
          `   • You can retry later with: ${pm.runner} @capgo/cli@latest key create`,
          '   • Meanwhile, never put API keys or backend secrets in the bundle.',
        ],
      }
    }
  }
  // If the user answered "not needed" to Q1, we keep the default
  // `skippedSummary`.

  globalEncryptionSummary = finalSummary
  setInitEncryptionSummary(finalSummary)
  await markStep(orgId, apikey, 'add-encryption', appId)
}

/**
 * Streams the output of an arbitrary command into the full-screen
 * streaming panel defined in `runtime.tsx` / `ui/app.tsx`. The Ink tree
 * switches to "streaming mode" while this helper is active: the normal
 * onboarding chrome (progress bar, logs, prompts) is hidden so long
 * command output has room to breathe.
 *
 * Returns `true` iff the process exits with code 0. On failure we leave
 * the panel on-screen with an error banner so the caller can decide how
 * long to pause before clearing it — that way the user actually has time
 * to read the failing output.
 */
async function streamCommandInInitPanel(params: {
  title: string
  runner: string // e.g. "npx", "bunx", "yarn dlx"
  args: string[]
  cwd?: string
}): Promise<{ success: boolean, error?: Error }> {
  // `pm.runner` can contain a space ("yarn dlx", "pnpm exec"). `spawn`
  // without `shell:true` can't handle that, and `shell:true` brings
  // quoting risk, so we split the runner into its own head + tail args.
  let runnerCommand
  try {
    runnerCommand = splitRunnerCommand(params.runner)
  }
  catch (error) {
    return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
  const { command: runnerCmd, args: runnerArgs } = runnerCommand
  const fullArgs = [...runnerArgs, ...params.args]
  const displayCommand = `${params.runner} ${params.args.join(' ')}`

  startInitStreamingOutput({ title: params.title, command: displayCommand })

  const appendChunk = (chunk: { toString: (encoding: string) => string } | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Capacitor CLI output mixes \r\n and bare \n; split on both but keep
    // non-empty trimmed lines so the panel doesn't fill with blank rows.
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\r/g, '')
      if (line.length > 0)
        appendInitStreamingLine(line)
    }
  }

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(runnerCmd, fullArgs, {
        // stdin ignored — cap sync is non-interactive. stdout/stderr piped
        // so Node can read them without touching the parent TTY that Ink
        // is actively rendering into.
        cwd: params.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
    catch (error) {
      updateInitStreamingStatus('error', error instanceof Error ? error.message : String(error))
      resolve({ success: false, error: error instanceof Error ? error : new Error(String(error)) })
      return
    }

    child.stdout?.on('data', appendChunk)
    child.stderr?.on('data', appendChunk)

    child.once('error', (error) => {
      updateInitStreamingStatus('error', error.message)
      resolve({ success: false, error })
    })

    child.once('close', (code) => {
      if (code === 0) {
        updateInitStreamingStatus('success', 'Done')
        resolve({ success: true })
        return
      }
      const err = new Error(`Command exited with code ${code ?? 'unknown'}`)
      updateInitStreamingStatus('error', err.message)
      resolve({ success: false, error: err })
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Flip the encryption summary panel from `pending-sync` to fully `enabled`
 * once `cap sync` has run successfully in `buildProjectStep`. Until that
 * point the native project hasn't been rebuilt with the new public key, so
 * claiming "Public RSA key is bundled in the app" would be a lie. Called
 * after a successful build & sync in `buildProjectStep`.
 */
function promoteEncryptionSummaryToEnabled(): void {
  if (!globalEncryptionSummary || globalEncryptionSummary.phase !== 'pending-sync')
    return
  const promoted: InitEncryptionSummary = {
    phase: 'enabled',
    title: '🔐 Encryption ENABLED',
    lines: [
      '   • Private RSA key stays on your machine — do not commit it.',
      '   • Public RSA key is bundled in the app (extractable by reverse engineering).',
      '   • Bundles encrypted with a random AES key, key wrapped with your RSA key.',
      '   • Bundle checksum is signed with your RSA key so the app can verify integrity.',
    ],
  }
  globalEncryptionSummary = promoted
  setInitEncryptionSummary(promoted)
}

type PackageManagerInfo = ReturnType<typeof getPMAndCommand>
export type PlatformChoice = 'ios' | 'android'
type BuildProjectStepOutcome = 'completed' | 'skipped'
export type RunDeviceStepOutcome = { args: string[], command: string } | { args: undefined, command: string }

export interface CapacitorRunTarget {
  name: string
  api: string | undefined
  id: string
}

interface CapacitorRunTargetListResult {
  targets: CapacitorRunTarget[]
  error?: Error
}

interface PackageRunnerListResult {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
  timedOut?: boolean
}

const iosRunTargetActions = {
  refresh: '__refresh__',
  simulator: '__simulator__',
  skip: '__skip__',
} as const
const IOS_SIMULATOR_TARGET_SUFFIX_RE = /\(simulator\)$/i
const INVALID_CAPACITOR_RUN_TARGET_IDS = new Set(['?'])
const DEFAULT_CAPACITOR_RUN_TARGET_LIST_TIMEOUT_MS = 30_000
type IosRunTargetResolution = RunDeviceStepOutcome | typeof iosRunTargetActions.refresh | typeof iosRunTargetActions.simulator
type IosSimulatorRunTargetResolution = RunDeviceStepOutcome | typeof iosRunTargetActions.refresh
type CapacitorRunTargetResolution = RunDeviceStepOutcome | typeof iosRunTargetActions.refresh

async function ensureNativePlatformForBuild(platform: PlatformChoice, config: CapacitorConfigSnapshot | undefined, runner: string, projectDir = cwd()): Promise<void> {
  const addPlatformCommand = formatRunnerCommand(runner, ['cap', 'add', platform])

  while (true) {
    const availablePlatforms = getNativePlatformAvailability(config, projectDir)
    const platformExists = platform === 'ios' ? availablePlatforms.ios : availablePlatforms.android
    if (platformExists)
      return

    const missingDir = platform === 'ios' ? availablePlatforms.iosDir : availablePlatforms.androidDir
    pLog.warn(`⚠️  ${missingDir}/ is missing, so Capgo cannot build the ${platform.toUpperCase()} project yet.`)

    const recoveryChoice = await pSelect({
      message: `How do you want to continue with ${platform.toUpperCase()}?`,
      options: [
        { value: 'add', label: `🛠  Run ${addPlatformCommand} now` },
        { value: 'doctor', label: 'Run doctor diagnostics now' },
        { value: 'exit', label: 'Exit onboarding' },
      ],
    })

    if (pIsCancel(recoveryChoice) || recoveryChoice === 'exit') {
      pOutro(`Bye 👋\n💡 Run "${addPlatformCommand}", then try again.`)
      return await exitAfterFinishingReplay()
    }

    if (recoveryChoice === 'doctor') {
      await runInitDoctorDiagnostics()
      continue
    }

    if (!await runCapacitorPlatformAdd(platform, runner, projectDir))
      pLog.warn(`Still could not add ${platform}.`)
  }
}

async function handleMissingBuildScript(buildCommand: string, appId: string, platform: PlatformChoice, orgId: string, apikey: string, pm: PackageManagerInfo): Promise<BuildProjectStepOutcome> {
  const spinner = pSpinner()
  spinner.start('Checking project type')
  spinner.stop('Missing build script', 'neutral')
  pLog.warn(`❌ Cannot find "${buildCommand}" script in package.json`)
  pLog.info(`💡 Your package.json needs a "${buildCommand}" script to build the app`)

  const skipBuild = await pConfirm({
    message: 'Would you like to skip the build for now and continue? You can build manually later.',
  })
  await cancelCommand(skipBuild, orgId, apikey)

  if (skipBuild) {
    pLog.info(`⏭️  Skipping build step - you can build manually with: ${pm.pm} run ${buildCommand}`)
    pLog.info(`📝 After building, run: ${pm.runner} cap sync ${platform}`)
    await markStep(orgId, apikey, 'build-project-skipped', appId)
    return 'skipped'
  }

  pOutro(`Bye 👋\n💡 Add a "${buildCommand}" script to package.json and run the command again`)
  return await exitAfterFinishingReplay()
}

async function getCompatibleUpdaterVersionForPackage(packageJsonPath: string, pm: PackageManagerInfo): Promise<string> {
  try {
    const dependencies = await getAllPackagesDependencies(undefined, packageJsonPath)
    const blocker = getUpdaterInstallBlocker(dependencies, pm)
    if (blocker)
      return 'latest'

    const coreVersion = normalizeConcreteVersion(dependencies.get('@capacitor/core'))!
    return getUpdaterVersionToInstall(coreVersion, false).versionToInstall
  }
  catch {
    return 'latest'
  }
}

async function handleBuildAndSyncFailure(
  platform: PlatformChoice,
  buildAndSyncCommand: string,
  packageJsonPath: string,
  pm: PackageManagerInfo,
  orgId: string,
  apikey: string,
  error: unknown,
): Promise<'retry' | 'completed'> {
  const formattedError = formatError(error)
  const updaterState = getUpdaterInstallState(packageJsonPath)

  pLog.error(`Build or sync failed: ${formattedError}`)

  if (!updaterState.ready) {
    pLog.warn(`Capacitor sync cannot wire ${CAPGO_UPDATER_PACKAGE} until it is declared and installed.`)
    const versionToInstall = await getCompatibleUpdaterVersionForPackage(packageJsonPath, pm)
    await waitForVerifiedUpdaterInstall(orgId, apikey, packageJsonPath, pm, versionToInstall, {
      failureText: formattedError,
      supportPlatform: platform,
    })
    return 'retry'
  }

  const recoveryChoice = await selectRecoveryOption(orgId, apikey, 'Build or sync failed. What do you want to do?', [
    { value: 'retry', label: 'Retry build and sync' },
    { value: 'manual', label: 'Fix it manually, then continue' },
  ], formattedError, platform)

  if (recoveryChoice === 'retry')
    return 'retry'

  await waitForReadyConfirmation(
    `Run or fix this command manually, then come back here:\n${buildAndSyncCommand}`,
    orgId,
    apikey,
    'Type "ready" when build and sync are done.',
  )

  return 'retry'
}

async function ensureUpdaterReadyBeforeSync(pm: PackageManagerInfo, orgId: string, apikey: string, packageJsonPath: string): Promise<void> {
  const updaterState = getUpdaterInstallState(packageJsonPath)
  if (updaterState.ready)
    return

  pLog.warn(`Capacitor sync needs ${CAPGO_UPDATER_PACKAGE} declared in package.json and installed first.`)
  const versionToInstall = await getCompatibleUpdaterVersionForPackage(packageJsonPath, pm)
  await waitForVerifiedUpdaterInstall(orgId, apikey, packageJsonPath, pm, versionToInstall, {
    failureText: updaterState.details.join('\n'),
  })
}

async function runBuildAndSyncLoop(
  platform: PlatformChoice,
  buildAndSyncCommand: string,
  buildAndSyncCwd: string,
  packageJsonPath: string,
  pm: PackageManagerInfo,
  orgId: string,
  apikey: string,
): Promise<void> {
  let iosSyncFailureCount = 0

  while (true) {
    await ensureUpdaterReadyBeforeSync(pm, orgId, apikey, packageJsonPath)

    const spinner = pSpinner()
    spinner.start('Preparing build and sync')
    const runMessage = buildAndSyncCwd === cwd()
      ? `Running: ${buildAndSyncCommand}`
      : `Running in ${buildAndSyncCwd}: ${buildAndSyncCommand}`
    spinner.stop(runMessage, 'neutral')
    try {
      const result = await runInheritedShellCommand(buildAndSyncCommand, { cwd: buildAndSyncCwd })
      if (result.error || result.status !== 0)
        throw result.error ?? new Error(`Build or sync command failed with ${formatInheritedCommandFailure(result)}`)
    }
    catch (error) {
      pLog.error('Build or sync failed ❌')
      const recovery = await handleBuildAndSyncFailure(platform, buildAndSyncCommand, packageJsonPath, pm, orgId, apikey, error)
      if (recovery === 'completed')
        return
      continue
    }

    if (platform === 'ios') {
      const syncValidation = validateIosUpdaterSync(buildAndSyncCwd, packageJsonPath)
      if (syncValidation.shouldCheck && !syncValidation.valid) {
        iosSyncFailureCount += 1
        spinner.stop('iOS sync check failed ❌')
        await handleBrokenIosSync(pm.runner, syncValidation.details, orgId, apikey, iosSyncFailureCount)
        pLog.info(`Retrying build and sync for iOS (attempt ${iosSyncFailureCount + 1})`)
        continue
      }
    }
    spinner.stop('Build & Sync Done ✅')
    promoteEncryptionSummaryToEnabled()
    return
  }
}
async function runProjectBuildAndSync(appId: string, platform: PlatformChoice, orgId: string, apikey: string, pm: PackageManagerInfo): Promise<BuildProjectStepOutcome> {
  const packageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
  const projectDir = dirname(packageJsonPath)
  const projectType = await findProjectType({ packageJsonPath })
  const buildCommand = await findBuildCommandForProjectType(projectType)
  const packScripts = getPackageScripts(undefined, packageJsonPath)

  if (!packScripts[buildCommand])
    return handleMissingBuildScript(buildCommand, appId, platform, orgId, apikey, pm)

  const buildAndSyncCommand = `${pm.pm} run ${buildCommand} && ${pm.runner} cap sync ${platform}`
  await runBuildAndSyncLoop(platform, buildAndSyncCommand, projectDir, packageJsonPath, pm, orgId, apikey)
  return 'completed'
}

async function buildProjectStep(orgId: string, apikey: string, appId: string, platform: 'ios' | 'android', config?: CapacitorConfigSnapshot) {
  const pm = getPMAndCommand()
  const packageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
  const projectDir = dirname(packageJsonPath)
  await ensureNativePlatformForBuild(platform, config, pm.runner, projectDir)

  const doBuild = await pConfirm({ message: `Automatic build ${appId} with "${pm.pm} run build" ?` })
  await cancelCommand(doBuild, orgId, apikey)
  if (!doBuild) {
    pLog.info(`Build yourself in ${projectDir} with command: ${pm.pm} run build && ${pm.runner} cap sync ${platform}`)
    await markStep(orgId, apikey, 'build-project', appId)
    return
  }

  const buildOutcome = await runProjectBuildAndSync(appId, platform, orgId, apikey, pm)
  if (buildOutcome === 'skipped')
    return

  await markStep(orgId, apikey, 'build-project', appId)
}

export function runPackageRunnerSync(runner: string, args: string[], options: Parameters<typeof spawnSync>[2]) {
  const parsedRunner = splitRunnerCommand(runner)
  return spawnSync(parsedRunner.command, [...parsedRunner.args, ...args], options)
}

async function runPackageRunnerInherited(runner: string, args: string[], options: Pick<InheritedCommandOptions, 'cwd'> = {}) {
  const parsedRunner = splitRunnerCommand(runner)
  return runInheritedCommand(parsedRunner.command, [...parsedRunner.args, ...args], options)
}

interface InheritedCommandResult {
  error?: Error
  signal: NodeJS.Signals | number | null
  status: number | null
}

interface InheritedCommandOptions {
  cwd?: string
  forcePty?: boolean
}

export async function runInheritedCommand(command: string, args: string[], options: InheritedCommandOptions = {}): Promise<InheritedCommandResult> {
  if (options.forcePty || (stdin.isTTY && stdout.isTTY))
    return runPtyInheritedCommand(command, args, options)
  return runPipedInheritedCommand(command, args, options)
}

function runPipedInheritedCommand(command: string, args: string[], options: Pick<InheritedCommandOptions, 'cwd'> = {}): Promise<InheritedCommandResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: InheritedCommandResult) => {
      if (settled)
        return
      settled = true
      resolve(result)
    }

    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
      })
    }
    catch (error) {
      finish({
        status: null,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      return
    }

    child.stdout?.on('data', chunk => stdout.write(chunk))
    child.stderr?.on('data', chunk => stderr.write(chunk))
    child.once('error', error => finish({
      status: null,
      signal: null,
      error,
    }))
    child.once('close', (status, signal) => finish({ status, signal }))
  })
}

function runDirectInheritedCommand(command: string, args: string[], options: Pick<InheritedCommandOptions, 'cwd'> = {}): Promise<InheritedCommandResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: 'inherit' })
    }
    catch (error) {
      resolve({
        status: null,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      return
    }

    child.once('error', error => resolve({
      status: null,
      signal: null,
      error,
    }))
    child.once('close', (status, signal) => resolve({ status, signal }))
  })
}

async function runPtyInheritedCommand(command: string, args: string[], options: Pick<InheritedCommandOptions, 'cwd'> = {}): Promise<InheritedCommandResult> {
  let spawnPty: typeof import('node-pty').spawn
  try {
    ;({ spawn: spawnPty } = await import('node-pty'))
  }
  catch {
    return runDirectInheritedCommand(command, args, options)
  }

  return new Promise((resolve) => {
    let settled = false
    let previousRawMode: boolean | undefined
    let ptyProcess: import('node-pty').IPty | undefined
    const inputHandler = (chunk: Buffer | string) => ptyProcess?.write(chunk)
    const resizeHandler = () => {
      try {
        ptyProcess?.resize(stdout.columns || 100, stdout.rows || 30)
      }
      catch {}
    }
    const cleanup = () => {
      stdout.off('resize', resizeHandler)
      stdin.off('data', inputHandler)
      if (stdin.isTTY && typeof previousRawMode === 'boolean')
        stdin.setRawMode?.(previousRawMode)
    }
    const finish = (result: InheritedCommandResult) => {
      if (settled)
        return
      settled = true
      cleanup()
      resolve(result)
    }

    try {
      ptyProcess = spawnPty(command, args, {
        cols: stdout.columns || 100,
        cwd: options.cwd || cwd(),
        env,
        name: env.TERM || 'xterm-256color',
        rows: stdout.rows || 30,
      })
    }
    catch {
      cleanup()
      void runDirectInheritedCommand(command, args, options).then(resolve)
      return
    }

    ptyProcess.onData(data => stdout.write(data))
    ptyProcess.onExit(({ exitCode, signal }) => finish({ status: exitCode, signal: signal ?? null }))
    stdout.on('resize', resizeHandler)
    stdin.on('data', inputHandler)
    if (stdin.isTTY) {
      previousRawMode = stdin.isRaw
      stdin.setRawMode?.(true)
      stdin.resume()
    }
  })
}

function runInheritedShellCommand(command: string, options: Pick<InheritedCommandOptions, 'cwd'> = {}) {
  const shellCommand = platform === 'win32' ? (env.ComSpec || 'cmd.exe') : '/bin/sh'
  const shellArgs = platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  return runInheritedCommand(shellCommand, shellArgs, options)
}

function formatInheritedCommandFailure(result: InheritedCommandResult) {
  if (result.error)
    return formatError(result.error)
  if (result.signal)
    return `signal ${result.signal}`
  return `exit code ${result.status ?? 'unknown'}`
}

function getSpawnOutputText(output: string | Buffer | null | undefined): string {
  if (!output)
    return ''
  return typeof output === 'string' ? output.trim() : output.toString('utf8').trim()
}

export function parseCapacitorRunTargetList(output: string): CapacitorRunTarget[] {
  return parseCapacitorRunTargetListResult(output).targets
}

function extractCapacitorRunTargetJson(output: string): string {
  const trimmed = output.trim()
  if (!trimmed || trimmed.startsWith('['))
    return trimmed

  const jsonStart = trimmed.indexOf('[')
  const jsonEnd = trimmed.lastIndexOf(']')
  return jsonStart >= 0 && jsonEnd > jsonStart
    ? trimmed.slice(jsonStart, jsonEnd + 1)
    : trimmed
}

function parseCapacitorRunTargetListResult(output: string): CapacitorRunTargetListResult {
  const trimmed = extractCapacitorRunTargetJson(output)
  if (!trimmed)
    return { targets: [], error: new Error('Capacitor returned no target list output.') }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    return { targets: [], error: new Error('Capacitor returned an invalid target list.') }
  }

  if (!Array.isArray(parsed))
    return { targets: [], error: new Error('Capacitor returned target list data in an unexpected format.') }

  const targets = parsed
    .filter((target): target is Record<string, unknown> => typeof target === 'object' && target !== null)
    .map((target) => {
      const id = typeof target.id === 'string' ? target.id.trim() : ''
      const rawName = typeof target.name === 'string' ? target.name.trim() : ''
      const api = typeof target.api === 'string' ? target.api.trim() : undefined
      return {
        id,
        name: rawName || id,
        api,
      }
    })
    .filter((target): target is CapacitorRunTarget => target.id.length > 0 && !INVALID_CAPACITOR_RUN_TARGET_IDS.has(target.id) && target.name.length > 0)

  return { targets }
}

export function getPhysicalIosRunTargets(targets: CapacitorRunTarget[]): CapacitorRunTarget[] {
  return targets.filter(target => !IOS_SIMULATOR_TARGET_SUFFIX_RE.test(target.name))
}

export function getSimulatorIosRunTargets(targets: CapacitorRunTarget[]): CapacitorRunTarget[] {
  return targets.filter(target => IOS_SIMULATOR_TARGET_SUFFIX_RE.test(target.name))
}

function getCapacitorRunTargetListTimeoutMs(): number {
  const rawTimeout = env.CAPGO_RUN_DEVICE_LIST_TIMEOUT_MS
  if (!rawTimeout)
    return DEFAULT_CAPACITOR_RUN_TARGET_LIST_TIMEOUT_MS

  const timeout = Number.parseInt(rawTimeout, 10)
  return Number.isFinite(timeout) && timeout > 0
    ? timeout
    : DEFAULT_CAPACITOR_RUN_TARGET_LIST_TIMEOUT_MS
}

function runPackageRunnerForTargetList(runner: string, args: string[], timeoutMs: number, projectDir = cwd()): Promise<PackageRunnerListResult> {
  let parsedRunner: ReturnType<typeof splitRunnerCommand>
  try {
    parsedRunner = splitRunnerCommand(runner)
  }
  catch (error) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      status: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
    })
  }

  return new Promise((resolve) => {
    let stdoutText = ''
    let stderrText = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const finish = (result: Omit<PackageRunnerListResult, 'stdout' | 'stderr'>) => {
      if (settled)
        return
      settled = true
      if (timeout)
        clearTimeout(timeout)
      resolve({
        stdout: stdoutText,
        stderr: stderrText,
        ...result,
      })
    }

    const child = spawn(parsedRunner.command, [...parsedRunner.args, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectDir,
    })

    timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish({
        status: null,
        signal: 'SIGTERM',
        timedOut: true,
      })
    }, timeoutMs)

    child.stdout?.on('data', chunk => stdoutText += chunk.toString())
    child.stderr?.on('data', chunk => stderrText += chunk.toString())
    child.on('error', error => finish({
      status: null,
      signal: null,
      error,
    }))
    child.on('close', (status, signal) => finish({
      status,
      signal,
    }))
  })
}

function createCapacitorRunTargetListError(runner: string, platformName: PlatformChoice, result: PackageRunnerListResult): Error {
  const args = ['cap', 'run', platformName, '--list', '--json']
  const command = formatRunnerCommand(runner, args)
  const output = getSpawnOutputText(result.stderr) || getSpawnOutputText(result.stdout)

  if (result.timedOut) {
    const seconds = Math.max(1, Math.ceil(getCapacitorRunTargetListTimeoutMs() / 1000))
    return new Error(`Timed out after ${seconds}s while checking ${platformName} targets. Run manually to see the native error: ${command}`)
  }

  if (result.error)
    return new Error(`${formatError(result.error)}. Run manually to see the native error: ${command}`)

  return new Error(output || `cap run ${platformName} --list exited with code ${result.status ?? 'unknown'}. Run manually to see the native error: ${command}`)
}

async function getCapacitorRunTargetList(runner: string, platformName: PlatformChoice, projectDir = cwd()): Promise<CapacitorRunTargetListResult> {
  try {
    const args = ['cap', 'run', platformName, '--list', '--json']
    const result = await runPackageRunnerForTargetList(runner, args, getCapacitorRunTargetListTimeoutMs(), projectDir)

    if (result.timedOut || result.error)
      return { targets: [], error: createCapacitorRunTargetListError(runner, platformName, result) }

    if (result.status !== 0)
      return { targets: [], error: createCapacitorRunTargetListError(runner, platformName, result) }

    const parseResult = parseCapacitorRunTargetListResult(getSpawnOutputText(result.stdout))
    if (parseResult.error)
      return { targets: [], error: new Error(`${formatError(parseResult.error)} Run manually to see the native output: ${formatRunnerCommand(runner, args)}`) }

    return parseResult
  }
  catch (error) {
    return { targets: [], error: error instanceof Error ? error : new Error(String(error)) }
  }
}

async function getCapacitorRunTargetListWithStatus(pm: PackageManagerInfo, platformName: PlatformChoice, message: string, projectDir = cwd()): Promise<CapacitorRunTargetListResult> {
  const s = pSpinner()
  s.start(message)
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  try {
    const result = await getCapacitorRunTargetList(pm.runner, platformName, projectDir)
    if (result.error)
      s.stop('Device check failed ❌', 'error')
    else
      s.stop()
    return result
  }
  catch (error) {
    s.stop('Device check failed ❌', 'error')
    return { targets: [], error: error instanceof Error ? error : new Error(String(error)) }
  }
}

function getRunDeviceCommand(pm: PackageManagerInfo, platformName: PlatformChoice, target?: CapacitorRunTarget): RunDeviceStepOutcome {
  const args = ['cap', 'run', platformName]
  if (target)
    args.push('--target', target.id)
  return { args, command: formatRunnerCommand(pm.runner, args) }
}

function getSkippedRunDeviceCommand(pm: PackageManagerInfo, platformName: PlatformChoice): RunDeviceStepOutcome {
  const args = ['cap', 'run', platformName]
  return { args: undefined, command: formatRunnerCommand(pm.runner, args) }
}

async function handlePhysicalIosRunTargets(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, physicalTargets: CapacitorRunTarget[]): Promise<IosRunTargetResolution> {
  const selectedTarget = await pSelect({
    message: 'Which physical iOS device do you want to run on?',
    options: [
      ...physicalTargets.map(target => ({
        value: target.id,
        label: target.name,
        hint: target.id,
      })),
      { value: iosRunTargetActions.refresh, label: 'Reload list' },
      { value: iosRunTargetActions.simulator, label: 'Use iOS Simulator instead' },
      { value: iosRunTargetActions.skip, label: 'Skip running now' },
    ],
  })

  if (pIsCancel(selectedTarget))
    await cancelHandler()

  if (selectedTarget === iosRunTargetActions.refresh)
    return iosRunTargetActions.refresh
  if (selectedTarget === iosRunTargetActions.simulator)
    return iosRunTargetActions.simulator
  if (selectedTarget === iosRunTargetActions.skip)
    return getSkippedRunDeviceCommand(pm, 'ios')

  const target = physicalTargets.find(({ id }) => id === selectedTarget)
  if (target)
    return getRunDeviceCommand(pm, 'ios', target)

  pLog.warn('That iOS device is no longer available. Checking again.')
  return iosRunTargetActions.refresh
}

async function handleMissingPhysicalIosRunTargets(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, listError?: Error): Promise<IosRunTargetResolution> {
  pLog.warn(listError ? 'The iOS device list is unavailable right now.' : 'No physical iOS device detected yet.')
  const nextAction = await pSelect({
    message: listError ? 'Fix the error above, then reload the list.' : 'Connect and unlock your iPhone, then check again.',
    options: [
      { value: iosRunTargetActions.refresh, label: 'Reload list' },
      { value: iosRunTargetActions.simulator, label: 'Use iOS Simulator instead' },
      { value: iosRunTargetActions.skip, label: 'Skip running now' },
    ],
  })

  if (pIsCancel(nextAction))
    await cancelHandler()

  if (nextAction === iosRunTargetActions.refresh)
    return iosRunTargetActions.refresh
  if (nextAction === iosRunTargetActions.simulator)
    return iosRunTargetActions.simulator
  return getSkippedRunDeviceCommand(pm, 'ios')
}

async function handleSimulatorIosRunTargets(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, simulatorTargets: CapacitorRunTarget[]): Promise<IosSimulatorRunTargetResolution> {
  const selectedTarget = await pSelect({
    message: 'Which iOS Simulator do you want to run on?',
    options: [
      ...simulatorTargets.map(target => ({
        value: target.id,
        label: target.name,
        hint: target.id,
      })),
      { value: iosRunTargetActions.refresh, label: 'Reload list' },
      { value: iosRunTargetActions.skip, label: 'Skip running now' },
    ],
  })

  if (pIsCancel(selectedTarget))
    await cancelHandler()

  if (selectedTarget === iosRunTargetActions.refresh)
    return iosRunTargetActions.refresh
  if (selectedTarget === iosRunTargetActions.skip)
    return getSkippedRunDeviceCommand(pm, 'ios')

  const target = simulatorTargets.find(({ id }) => id === selectedTarget)
  if (target)
    return getRunDeviceCommand(pm, 'ios', target)

  pLog.warn('That iOS Simulator is no longer available. Checking again.')
  return iosRunTargetActions.refresh
}

async function handleMissingSimulatorIosRunTargets(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, listError?: Error): Promise<IosSimulatorRunTargetResolution> {
  pLog.warn(listError ? 'The iOS Simulator list is unavailable right now.' : 'No iOS Simulator detected yet.')
  const nextAction = await pSelect({
    message: listError ? 'Fix the error above, then reload the list.' : 'Open Xcode or install a simulator, then check again.',
    options: [
      { value: iosRunTargetActions.refresh, label: 'Reload list' },
      { value: iosRunTargetActions.skip, label: 'Skip running now' },
    ],
  })

  if (pIsCancel(nextAction))
    await cancelHandler()

  if (nextAction === iosRunTargetActions.refresh)
    return iosRunTargetActions.refresh
  return getSkippedRunDeviceCommand(pm, 'ios')
}

async function selectSimulatorIosRunTarget(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, initialTargets?: CapacitorRunTarget[], projectDir = cwd()): Promise<RunDeviceStepOutcome> {
  let knownTargets = initialTargets

  while (true) {
    const result = knownTargets
      ? { targets: knownTargets }
      : await getCapacitorRunTargetListWithStatus(pm, 'ios', 'Checking iOS Simulators...', projectDir)
    knownTargets = undefined

    if ('error' in result && result.error)
      pLog.warn(`Could not check iOS Simulators: ${formatError(result.error)}`)

    const simulatorTargets = getSimulatorIosRunTargets(result.targets)

    const selectionResult = simulatorTargets.length > 0
      ? await handleSimulatorIosRunTargets(cancelHandler, pm, simulatorTargets)
      : await handleMissingSimulatorIosRunTargets(cancelHandler, pm, result.error)
    if (selectionResult === iosRunTargetActions.refresh)
      continue
    return selectionResult
  }
}

async function selectPhysicalIosRunTarget(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, projectDir = cwd()): Promise<RunDeviceStepOutcome> {
  pLog.info('Connect your iPhone or iPad, unlock it, and tap Trust if prompted.')

  while (true) {
    const result = await getCapacitorRunTargetListWithStatus(pm, 'ios', 'Checking connected iOS devices...', projectDir)
    if (result.error)
      pLog.warn(`Could not check connected iOS devices: ${formatError(result.error)}`)

    const physicalTargets = getPhysicalIosRunTargets(result.targets)

    const selectionResult = physicalTargets.length > 0
      ? await handlePhysicalIosRunTargets(cancelHandler, pm, physicalTargets)
      : await handleMissingPhysicalIosRunTargets(cancelHandler, pm, result.error)
    if (selectionResult === iosRunTargetActions.refresh)
      continue
    if (selectionResult === iosRunTargetActions.simulator)
      return selectSimulatorIosRunTarget(cancelHandler, pm, result.targets, projectDir)
    return selectionResult
  }
}

function getRunTargetLabel(platformName: PlatformChoice): string {
  return platformName === 'ios' ? 'iOS device or simulator' : 'Android device or emulator'
}

async function handleCapacitorRunTargets(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, platformName: PlatformChoice, targets: CapacitorRunTarget[]): Promise<CapacitorRunTargetResolution> {
  const targetLabel = getRunTargetLabel(platformName)
  const selectedTarget = await pSelect({
    message: `Which ${targetLabel} do you want to run on?`,
    options: [
      ...targets.map(target => ({
        value: target.id,
        label: target.name,
        hint: target.id,
      })),
      { value: iosRunTargetActions.refresh, label: 'Reload list' },
      { value: iosRunTargetActions.skip, label: 'Skip running now' },
    ],
  })

  if (pIsCancel(selectedTarget))
    await cancelHandler()

  if (selectedTarget === iosRunTargetActions.refresh)
    return iosRunTargetActions.refresh
  if (selectedTarget === iosRunTargetActions.skip)
    return getSkippedRunDeviceCommand(pm, platformName)

  const target = targets.find(({ id }) => id === selectedTarget)
  if (target)
    return getRunDeviceCommand(pm, platformName, target)

  pLog.warn(`That ${targetLabel} is no longer available. Checking again.`)
  return iosRunTargetActions.refresh
}

async function handleMissingCapacitorRunTargets(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, platformName: PlatformChoice, listError?: Error): Promise<CapacitorRunTargetResolution> {
  const targetLabel = getRunTargetLabel(platformName)
  pLog.warn(listError ? `The ${targetLabel} list is unavailable right now.` : `No ${targetLabel} detected yet.`)
  const nextAction = await pSelect({
    message: listError ? 'Fix the error above, then reload the list.' : 'Connect or start one, then reload the list.',
    options: [
      { value: iosRunTargetActions.refresh, label: 'Reload list' },
      { value: iosRunTargetActions.skip, label: 'Skip running now' },
    ],
  })

  if (pIsCancel(nextAction))
    await cancelHandler()

  if (nextAction === iosRunTargetActions.refresh)
    return iosRunTargetActions.refresh
  return getSkippedRunDeviceCommand(pm, platformName)
}

async function selectCapacitorRunTarget(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, platformName: PlatformChoice, projectDir = cwd()): Promise<RunDeviceStepOutcome> {
  while (true) {
    const result = await getCapacitorRunTargetListWithStatus(pm, platformName, 'Checking available Android devices and emulators...', projectDir)
    if (result.error)
      pLog.warn(`Could not check available devices: ${formatError(result.error)}`)

    const selectionResult = result.targets.length > 0
      ? await handleCapacitorRunTargets(cancelHandler, pm, platformName, result.targets)
      : await handleMissingCapacitorRunTargets(cancelHandler, pm, platformName, result.error)
    if (selectionResult === iosRunTargetActions.refresh)
      continue
    return selectionResult
  }
}

export async function resolveRunDeviceCommand(cancelHandler: RunDeviceCancelHandler, pm: PackageManagerInfo, platformName: PlatformChoice, projectDir = cwd()): Promise<RunDeviceStepOutcome> {
  if (platformName !== 'ios')
    return selectCapacitorRunTarget(cancelHandler, pm, platformName, projectDir)

  const targetKind = await pSelect({
    message: 'Where do you want to run the iOS app?',
    options: [
      { value: 'physical', label: 'Physical iPhone or iPad' },
      { value: 'simulator', label: 'iOS Simulator' },
    ],
  })

  if (pIsCancel(targetKind))
    await cancelHandler()

  if (targetKind === 'simulator')
    return selectSimulatorIosRunTarget(cancelHandler, pm, undefined, projectDir)

  return selectPhysicalIosRunTarget(cancelHandler, pm, projectDir)
}

function getSelectablePlatformOptions(config?: CapacitorConfigSnapshot, projectDir = cwd()): Array<{ value: PlatformChoice, label: string }> {
  const availablePlatforms = getNativePlatformAvailability(config, projectDir)
  const options: Array<{ value: PlatformChoice, label: string }> = []
  if (availablePlatforms.ios)
    options.push({ value: 'ios', label: 'IOS' })
  if (availablePlatforms.android)
    options.push({ value: 'android', label: 'Android' })
  return options
}

async function promptForSelectedPlatform(orgId: string, apikey: string, options: Array<{ value: PlatformChoice, label: string }>): Promise<PlatformChoice> {
  const platformType = await pSelect({
    message: 'Which platform do you want to test with during this onboarding?',
    options,
  })
  if (pIsCancel(platformType))
    await exitCanceledInitOnboarding(orgId, apikey)

  const platform = platformType as PlatformChoice
  pLog.info(`🎯 Testing with: ${platform.toUpperCase()}`)
  pLog.info(`💡 Note: Onboarding builds will use ${platform} only`)
  await markStep(orgId, apikey, 'select-platform', platform)
  return platform
}

async function handleMissingPlatformSelection(orgId: string, apikey: string, availablePlatforms: ReturnType<typeof getNativePlatformAvailability>, projectDir = cwd()): Promise<void> {
  const { pm, capAddAndroid, capAddIos } = getInitRecoveryCommands()
  pLog.warn(`⚠️  No native platform directories found (${availablePlatforms.iosDir}/ or ${availablePlatforms.androidDir}/).`)
  const recoveryChoice = await pSelect({
    message: 'Add a native platform before choosing a test platform.',
    options: [
      { value: 'add-ios', label: `🛠  Run ${capAddIos} now` },
      { value: 'add-android', label: `🛠  Run ${capAddAndroid} now` },
      { value: 'doctor', label: 'Run doctor diagnostics now' },
      { value: 'exit', label: 'Exit onboarding' },
    ],
  })

  if (pIsCancel(recoveryChoice) || recoveryChoice === 'exit')
    await exitCanceledInitOnboarding(orgId, apikey, `Run "${capAddIos}" or "${capAddAndroid}", then try again.`)

  if (recoveryChoice === 'doctor') {
    await runInitDoctorDiagnostics()
    return
  }

  const platformToAdd = recoveryChoice === 'add-ios' ? 'ios' : 'android'
  if (!await runCapacitorPlatformAdd(platformToAdd, pm.runner, projectDir))
    pLog.warn(`Still could not add ${platformToAdd}.`)
}

export function normalizeRunDevicePlatform(platformName: string): PlatformChoice {
  const normalized = platformName.toLowerCase()
  if (normalized === 'ios' || normalized === 'android')
    return normalized
  throw new Error('Platform must be "ios" or "android".')
}

async function selectPlatformStep(orgId: string, apikey: string, config?: CapacitorConfigSnapshot, projectDir = cwd()): Promise<'ios' | 'android'> {
  pLog.info(`📱 Platform selection for onboarding`)
  pLog.info(`   This is just for testing during onboarding - your app will work on all platforms`)

  while (true) {
    const options = getSelectablePlatformOptions(config, projectDir)
    if (options.length > 0)
      return promptForSelectedPlatform(orgId, apikey, options)

    await handleMissingPlatformSelection(orgId, apikey, getNativePlatformAvailability(config, projectDir), projectDir)
  }
}

async function runDeviceStep(orgId: string, apikey: string, appId: string, platform: 'ios' | 'android', projectDir = cwd()) {
  const pm = getPMAndCommand()
  const doRun = await pConfirm({ message: `Run ${appId} on ${platform.toUpperCase()} device now to test the initial version?` })
  await cancelCommand(doRun, orgId, apikey)
  if (doRun) {
    const runCommand = await resolveRunDeviceCommand(() => exitCanceledInitOnboarding(orgId, apikey), pm, platform, projectDir)
    if (!runCommand.args) {
      pLog.info(`Skipped device launch. You can run it manually in ${projectDir} with: ${runCommand.command}`)
      await markStep(orgId, apikey, 'run-device', appId)
      return
    }

    const s = pSpinner()
    const runMessage = projectDir === cwd()
      ? `Running: ${runCommand.command}`
      : `Running in ${projectDir}: ${runCommand.command}`
    s.start(runMessage)

    let runResult: InheritedCommandResult | undefined
    let runError: Error | undefined
    try {
      runResult = await runPackageRunnerInherited(pm.runner, runCommand.args, { cwd: projectDir })
    }
    catch (error) {
      runError = error instanceof Error ? error : new Error(String(error))
    }
    const runFailed = runError || runResult?.error || runResult?.status !== 0

    if (runFailed) {
      const platformName = platform === 'ios' ? 'iOS' : 'Android'
      s.stop(`App failed to start ❌`)
      appendInternalLog(`app run failed (${platformName}): ${(runError || runResult?.error) ? formatError(runError ?? runResult?.error) : `exit status ${runResult?.status ?? 'unknown'}`}`)
      if (runError || runResult?.error)
        pLog.error(formatError(runError ?? runResult?.error))
      pLog.error(`The app failed to start on your ${platformName} device.`)

      const openIDE = await pConfirm({
        message: `Would you like to open ${platform === 'ios' ? 'Xcode' : 'Android Studio'} to run the app manually?`,
      })

      if (!pIsCancel(openIDE) && openIDE) {
        const s2 = pSpinner()
        s2.start(`Opening ${platform === 'ios' ? 'Xcode' : 'Android Studio'}...`)
        try {
          const openResult = await runPackageRunnerInherited(pm.runner, ['cap', 'open', platform], { cwd: projectDir })
          if (openResult.error || openResult.status !== 0) {
            s2.stop(`Could not open ${platform === 'ios' ? 'Xcode' : 'Android Studio'} ❌`)
            if (openResult.error)
              pLog.error(formatError(openResult.error))
            pLog.info(`You can run the app manually in ${projectDir} with: ${runCommand.command}`)
          }
          else {
            s2.stop(`IDE opened ✅`)
            pLog.info(`Please run the app manually from ${platform === 'ios' ? 'Xcode' : 'Android Studio'}`)
          }
        }
        catch (error) {
          s2.stop(`Could not open ${platform === 'ios' ? 'Xcode' : 'Android Studio'} ❌`)
          pLog.error(formatError(error))
          pLog.info(`You can run the app manually in ${projectDir} with: ${runCommand.command}`)
        }
      }
      else {
        pLog.info(`You can run the app manually in ${projectDir} with: ${runCommand.command}`)
      }
    }
    else {
      s.stop(`App started ✅`)
      pLog.info(`📱 Your app should now be running on your ${platform} device with Capgo integrated`)
      pLog.info(`🔄 This is your baseline version - we'll create an update next`)
    }
  }
  else {
    pLog.info(`If you change your mind, run it for yourself in ${projectDir} with: ${pm.runner} cap run ${platform}`)
  }
  await markStep(orgId, apikey, 'run-device', appId)
}

async function addCodeChangeStep(orgId: string, apikey: string, appId: string, pkgVersion: string, platform: 'ios' | 'android') {
  pLog.info(`🎯 Now let's test Capgo by making a visible change and deploying an update!`)
  // Keep any restored auto-test change metadata on resume so step 12 can
  // still offer cleanup after an interrupted step-9 flow.
  const packageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
  const projectDir = dirname(packageJsonPath)

  const modificationType = await pSelect({
    message: 'How would you like to test the update?',
    options: [
      { value: 'auto', label: 'Auto: Let Capgo CLI make a visible change for you' },
      { value: 'manual', label: 'Manual: I\'ll make changes myself' },
    ],
  })
  if (pIsCancel(modificationType)) {
    await markInitSnag(orgId, apikey, 'canceled', undefined, '🤷')
    pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
    return await exitAfterFinishingReplay()
  }

  if (modificationType === 'auto') {
    const s = pSpinner()
    s.start('Making automatic changes to test Capgo updates')

    let changed = false

    // Try to find and modify ONE file only, prioritizing HTML files
    const possibleFiles = [
      'src/index.html',
      'public/index.html',
      'index.html',
      'src/App.vue',
      'src/app/app.component.html',
      'src/app/home/home.page.html',
      'src/main.css',
      'src/style.css',
      'public/style.css',
    ]

    for (const relativeFilePath of possibleFiles) {
      const filePath = join(projectDir, relativeFilePath)
      if (existsSync(filePath) && !changed) {
        try {
          const content = readFileSync(filePath, 'utf8')
          const appliedChange = applyInitAutoTestChange(relativeFilePath, content)
          if (appliedChange) {
            writeFileSync(filePath, appliedChange.content, 'utf8')
            const displayPath = formatInitFilePath(filePath)
            s.stop(`✅ Made test changes to ${displayPath}`)
            pLog.info(`📝 Added visible test modification to verify the update works`)
            globalAutoTestChange = {
              filePath,
              displayPath,
              kind: appliedChange.kind,
            }
            // Persist the step-8 checkpoint immediately so resume can still
            // offer cleanup if the user exits later in this step.
            markStepDone(8)
            changed = true
            break
          }
        }
        catch {
          // Continue to next file
        }
      }
    }

    if (!changed) {
      s.stop('⚠️  Could not automatically modify files', 'neutral')
      pLog.warn('Please make a visible change manually (like editing a text or color)')
      const continueManual = await pConfirm({ message: 'Continue after making your changes?' })
      await cancelCommand(continueManual, orgId, apikey)
    }
  }
  else {
    pLog.info(`✋ Please make a visible change to your app now (example: change a text, color, or add an element)`)
    pLog.info(`💡 This change will help you see that Capgo updates work correctly`)
    const changesReady = await pConfirm({ message: 'Have you made your changes and ready to continue?' })
    await cancelCommand(changesReady, orgId, apikey)
  }

  // Version bump
  const otaVersionBase = getInitOtaVersionBase(pkgVersion)
  const nextVersion = getInitSuggestedOtaVersion(pkgVersion)
  pLog.info(`🔢 OTA update versioning:`)
  if (otaVersionBase === initNativeBundleVersion && pkgVersion !== initNativeBundleVersion) {
    pLog.info(`   Init pinned CapacitorUpdater.version to ${initNativeBundleVersion} for this guided test.`)
    pLog.info(`   Keep the first OTA upload on major 0 (for example ${otaVersionBase} → ${nextVersion}) to avoid channel major-gate blocks.`)
  }
  else {
    pLog.info(`   Each upload must use a new version (for example ${otaVersionBase} → ${nextVersion})`)
  }
  const versionChoice = await pSelect({
    message: 'How do you want to handle the version for this update?',
    options: [
      { value: 'auto', label: `Auto: Bump patch version (${otaVersionBase} → ${nextVersion})` },
      { value: 'manual', label: 'Manual: I\'ll provide the version number' },
    ],
  })
  if (pIsCancel(versionChoice)) {
    await markInitSnag(orgId, apikey, 'canceled', undefined, '🤷')
    pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
    return await exitAfterFinishingReplay()
  }

  let newVersion: string
  if (versionChoice === 'auto') {
    newVersion = nextVersion
    pLog.info(`🔢 Auto-bumped version from ${otaVersionBase} to ${newVersion}`)
  }
  else {
    const userVersion = await pText({
      message: otaVersionBase === pkgVersion
        ? `Current version is ${otaVersionBase}. Enter new version:`
        : `Guided OTA baseline is ${otaVersionBase}. Enter a new 0.x.x version:`,
      validate: (value) => {
        if (!value?.match(/^\d+\.\d+\.\d+/))
          return 'Please enter a valid version (x.y.z)'
      },
    })
    if (pIsCancel(userVersion)) {
      await markInitSnag(orgId, apikey, 'canceled', undefined, '🤷')
      pOutro(`Bye 👋\n💡 You can resume the onboarding anytime by running the same command again`)
      return await exitAfterFinishingReplay()
    }
    newVersion = userVersion as string
  }
  pLog.info(`🧭 This OTA upload will use version ${newVersion}. For the next test, increment it again.`)
  // Build after modifications
  const pm = getPMAndCommand()
  const projectType = await findProjectType({ packageJsonPath })
  const buildCommand = await findBuildCommandForProjectType(projectType)
  const printManualOtaBuildInstructions = () => {
    pLog.info(`Build web assets manually in ${projectDir} with: ${pm.pm} run ${buildCommand}`)
    pLog.warn(`Do NOT run "${pm.runner} cap sync ${platform}" for this OTA test.`)
    pLog.warn(`Why: "${pm.runner} cap sync ${platform}" copies the current web build into the native project and regenerates native plugin files.`)
    pLog.warn('If you sync now, the native app already contains your new change before Capgo download, so you cannot verify OTA behavior.')
    pLog.info('Sync is safe again only after you confirmed the OTA update on device, or when preparing a new native/App Store build.')
  }

  const doBuild = await pConfirm({
    message: `Build ${appId} web assets before uploading with "${pm.pm} run ${buildCommand}"? (no cap sync)`,
  })
  await cancelCommand(doBuild, orgId, apikey)
  if (doBuild) {
    const s = pSpinner()
    s.start(`Running in ${projectDir}: ${pm.pm} run ${buildCommand}`)
    const packScripts = getPackageScripts(undefined, packageJsonPath)
    // check in script build exist
    if (!packScripts[buildCommand]) {
      s.stop('Missing build script', 'neutral')
      pLog.warn(`❌ Cannot find "${buildCommand}" script in package.json`)
      pLog.info(`💡 Build manually in another terminal, then come back and continue`)
      printManualOtaBuildInstructions()

      const builtManually = await pConfirm({
        message: `Have you built the app manually? (If not, we'll skip the build)`,
      })
      await cancelCommand(builtManually, orgId, apikey)

      if (!builtManually) {
        pLog.warn(`⚠️  Continuing without build - upload may fail if app isn't built`)
        printManualOtaBuildInstructions()
      }
      else {
        pLog.info(`✅ Great! Continuing with your manual build`)
      }
    }
    else {
      try {
        const buildResult = spawnSync(pm.pm, ['run', buildCommand], { stdio: 'pipe', cwd: projectDir })
        if (buildResult.error) {
          throw buildResult.error
        }
        if (buildResult.status !== 0) {
          throw new Error(`Build command "${pm.pm} run ${buildCommand}" failed with exit code ${buildResult.status ?? 'unknown'}`)
        }
        s.stop(`✅ Build with changes completed`)
        pLog.info(`📦 Your modifications are built and ready for OTA upload`)
      }
      catch {
        s.stop('Build failed ❌')
        pLog.warn('Automatic build failed.')
        printManualOtaBuildInstructions()

        const builtManually = await pConfirm({
          message: 'Have you built the app manually now? (If not, we will continue without build)',
        })
        await cancelCommand(builtManually, orgId, apikey)

        if (!builtManually) {
          pLog.warn(`⚠️  Continuing without build - upload may fail if app isn't built`)
        }
      }
    }
  }
  else {
    printManualOtaBuildInstructions()
  }

  await markStep(orgId, apikey, 'add-code-change', appId)
  return newVersion
}

function getSuggestedCleanupBundleVersion(currentVersion: string) {
  try {
    return format(increment(parse(currentVersion), 'patch'))
  }
  catch {
    return '1.0.2'
  }
}

async function maybeOfferAutoTestCleanup(orgId: string, apikey: string, appId: string, currentVersion: string, platform: 'ios' | 'android', delta: boolean) {
  const autoTestChange = globalAutoTestChange
  if (!autoTestChange)
    return

  pLog.info(`Capgo CLI added a temporary onboarding test change in ${autoTestChange.displayPath}.`)

  const shouldRevert = await pConfirm({
    message: 'Do you want me to revert that temporary test change now?',
    initialValue: true,
  })
  await cancelCommand(shouldRevert, orgId, apikey)

  let reverted = false
  if (shouldRevert) {
    if (!existsSync(autoTestChange.filePath)) {
      pLog.warn(`${autoTestChange.displayPath} no longer exists, so there is nothing left to revert automatically.`)
      reverted = true
      globalAutoTestChange = undefined
    }
    else {
      try {
        const currentContent = readFileSync(autoTestChange.filePath, 'utf8')
        const revertedContent = revertInitAutoTestChangeContent(autoTestChange.kind, currentContent)
        if (!revertedContent) {
          pLog.warn(`Could not automatically revert ${autoTestChange.displayPath}. Please revert it manually.`)
        }
        else {
          writeFileSync(autoTestChange.filePath, revertedContent, 'utf8')
          pLog.success(`Reverted ${autoTestChange.displayPath} ✅`)
          reverted = true
          globalAutoTestChange = undefined
        }
      }
      catch (error) {
        const fileError = error as NodeJS.ErrnoException
        if (fileError.code === 'ENOENT') {
          pLog.warn(`${autoTestChange.displayPath} was removed before cleanup, so there is nothing left to revert automatically.`)
          reverted = true
          globalAutoTestChange = undefined
        }
        else {
          pLog.warn(`Could not automatically revert ${autoTestChange.displayPath}: ${formatError(error)}`)
        }
      }
    }
  }

  let buildCommand = 'build'
  try {
    const projectType = await findProjectType({ packageJsonPath: globalPathToPackageJson })
    buildCommand = await findBuildCommandForProjectType(projectType)
  }
  catch (err) {
    appendInternalLog(`project-type detection failed, defaulting buildCommand to 'build': ${err instanceof Error ? err.message : String(err)}`)
  }

  const pm = getPMAndCommand()
  const cleanupVersion = getSuggestedCleanupBundleVersion(currentVersion)
  const cleanupUploadCommand = [
    `${pm.runner} @capgo/cli@latest bundle upload ${appId}`,
    `--bundle ${cleanupVersion}`,
    `--channel ${globalChannelName}`,
    delta ? '--delta-only' : '',
    globalPathToPackageJson ? `--package-json ${globalPathToPackageJson}` : '',
    globalNodeModulesPath ? `--node-modules ${globalNodeModulesPath}` : '',
  ].filter(Boolean).join(' ')

  pLog.info(reverted
    ? 'Build and upload one more cleanup bundle so the onboarding test change disappears from the installed app.'
    : 'After you revert that onboarding test change, build and upload one more cleanup bundle so it disappears from the installed app.')
  pLog.info(`Suggested cleanup build: ${pm.pm} run ${buildCommand}`)
  pLog.info(`Suggested cleanup upload: ${cleanupUploadCommand}`)
  pLog.warn(`Do not run "${pm.runner} cap sync ${platform}" before this cleanup upload.`)
}

async function uploadStep(orgId: string, apikey: string, appId: string, newVersion: string, delta: boolean, supportPlatform: PlatformChoice) {
  const pm = getPMAndCommand()
  const selectedPackageJsonPath = globalPathToPackageJson ? path.resolve(globalPathToPackageJson) : undefined
  const selectedProjectDir = selectedPackageJsonPath ? dirname(selectedPackageJsonPath) : cwd()
  const doBundle = await pConfirm({ message: `Upload the updated ${appId} bundle (v${newVersion}) to Capgo?` })
  await cancelCommand(doBundle, orgId, apikey)
  if (doBundle) {
    let nodeModulesPath: string | undefined
    const isMonorepo = projectIsMonorepo(cwd())
    while (true) {
      const s = pSpinner()
      s.start(`Running: ${pm.runner} @capgo/cli@latest bundle upload ${delta ? '--delta-only' : ''}`)
      if (globalPathToPackageJson && isMonorepo) {
        pLog.warn(`You are most likely using a monorepo, please provide the path to your package.json file AND node_modules path folder when uploading your bundle`)
        pLog.warn(`Example: ${pm.runner} @capgo/cli@latest bundle upload --package-json ./packages/my-app/package.json --node-modules ./packages/my-app/node_modules ${delta ? '--delta-only' : ''}`)
        nodeModulesPath ||= join(findRoot(cwd()), 'node_modules')
        pLog.warn(`Using node modules path: ${nodeModulesPath}`)
        if (!existsSync(nodeModulesPath)) {
          s.stop('Upload blocked ❌')
          pLog.error(`Node modules path does not exist`)
          nodeModulesPath = await askForExistingDirectoryPath(orgId, apikey, 'Enter the path to the correct node_modules directory:', nodeModulesPath)
          continue
        }
      }

      globalNodeModulesPath = isMonorepo ? nodeModulesPath : undefined

      let uploadRes: Awaited<ReturnType<typeof uploadBundleInternal>> | undefined
      try {
        const previousCwd = cwd()
        try {
          chdir(selectedProjectDir)
          uploadRes = await uploadBundleInternal(appId, {
            channel: globalChannelName,
            apikey,
            packageJson: isMonorepo ? selectedPackageJsonPath : undefined,
            nodeModules: isMonorepo ? nodeModulesPath : undefined,
            deltaOnly: delta,
            bundle: newVersion,
            ignoreChecksumCheck: true,
            // Onboarding owns replication UX after the upload spinner stops.
            showReplicationProgress: false,
          }, false)
        }
        finally {
          chdir(previousCwd)
        }
      }
      catch (error) {
        s.stop('Upload failed ❌')
        pLog.error(formatError(error))
        await selectRecoveryOption(orgId, apikey, 'Bundle upload failed. What do you want to do?', [
          { value: 'retry', label: 'Retry bundle upload' },
        ], formatError(error), supportPlatform)
        continue
      }
      if (!uploadRes?.success) {
        s.stop('Upload failed ❌')
        await selectRecoveryOption(orgId, apikey, 'Bundle upload failed. What do you want to do?', [
          { value: 'retry', label: 'Retry bundle upload' },
        ], 'Bundle upload did not complete successfully.', supportPlatform)
        continue
      }

      s.stop(`✅ Update v${newVersion} uploaded successfully!`)
      await showReplicationProgress({
        title: 'Replicating your updated bundle in onboarding regions.',
        completeMessage: 'Update replication is now fully propagated.',
        interactive: !!stdin.isTTY && !!stdout.isTTY,
      })
      pLog.info(`🎉 Your updated bundle is now available on Capgo`)
      break
    }
  }
  else {
    const manualUploadCommandParts = [
      `${pm.runner} @capgo/cli@latest bundle upload ${appId}`,
      `--bundle ${newVersion}`,
      `--channel ${globalChannelName}`,
      delta ? '--delta-only' : '',
      globalPathToPackageJson ? `--package-json ${globalPathToPackageJson}` : '',
    ]
    const manualUploadCommand = manualUploadCommandParts.filter(Boolean).join(' ')
    pLog.info(`Upload yourself from ${selectedProjectDir} with command: ${manualUploadCommand}`)
  }
  await markStep(orgId, apikey, 'upload', appId)
}

async function testCapgoUpdateStep(orgId: string, apikey: string, appId: string, hostWeb: string, delta: boolean) {
  pLog.info(`🧪 Time to test the Capgo update system!`)
  pLog.info(`📱 Go to your device where the app is running`)

  if (delta) {
    pLog.info(`🔄 IMPORTANT: Background your app (swipe up/press home button) and then reopen it`)
    pLog.info(`⏱️  The update should be downloaded and applied automatically`)
  }
  else {
    pLog.info(`📱 With standard updates, you will need to:`)
    pLog.info(`   1. Background the app (swipe up/press home button) to start download`)
    pLog.info(`   2. Wait a few seconds for download to complete`)
    pLog.info(`   3. Background and foreground again to see the update`)
  }

  pLog.info(`👀 You should see your changes appear in the app!`)

  const doWaitLogs = await pConfirm({ message: `Monitor Capgo logs to verify the update worked?` })
  await cancelCommand(doWaitLogs, orgId, apikey)

  if (doWaitLogs) {
    pLog.info(`📊 Watching logs from ${appId}...`)
    pLog.info(`🔄 Please background and reopen your app now to trigger the update`)
    await waitLog('onboarding-v2', apikey, appId, apikey, orgId)
  }
  else {
    pLog.info(`📊 Check logs manually at ${hostWeb}/app/${appId}/logs to verify the update`)
  }
  await markStep(orgId, apikey, 'test-update', appId)
}

const capgoSkillsRepository = 'https://github.com/Cap-go/capgo-skills'
const capgoSkillsStarRepository = 'Cap-go/capgo-skills'

function formatGithubRepositoryList(repositories: string[]) {
  if (repositories.length === 0)
    return ''
  if (repositories.length === 1)
    return repositories[0]
  if (repositories.length === 2)
    return `${repositories[0]} and ${repositories[1]}`

  return `${repositories.slice(0, -1).join(', ')}, and ${repositories.at(-1)}`
}

async function maybeInstallCapgoSkills() {
  if (!stdin.isTTY || !stdout.isTTY)
    return false

  const pm = getPMAndCommand()
  const installCommand = `${pm.runner} skills add ${capgoSkillsRepository} -g -y`
  const shouldInstall = await pConfirm({
    message: 'Install Capgo capacitor skills (capgo-skills) for your coding agent?',
    initialValue: true,
  })

  if (pIsCancel(shouldInstall) || !shouldInstall)
    return false

  pLog.info(`Running command: ${installCommand}`)

  const spinner = pSpinner()
  spinner.start(`Running: ${installCommand}`)

  try {
    const result = spawnSync(pm.runner, ['skills', 'add', capgoSkillsRepository, '-g', '-y'], {
      stdio: 'pipe',
      encoding: 'utf8',
    })

    if (result.status === 0) {
      spinner.stop('Capgo skills install Done ✅')
      return true
    }

    spinner.stop('Capgo skills install failed ❌')
    const commandError = [result.stderr, result.stdout]
      .find(value => typeof value === 'string' && value.trim().length > 0)
      ?.trim()
    pLog.warn(`Could not install Capgo skills automatically: ${commandError || 'Unknown error'}`)
    pLog.info(`Run it yourself with: "${installCommand}"`)
    return true
  }
  catch (error) {
    spinner.stop('Capgo skills install failed ❌')
    pLog.warn(`Could not install Capgo skills automatically: ${formatError(error)}`)
    pLog.info(`Run it yourself with: "${installCommand}"`)
    return true
  }
}

async function maybeStarCapgoRepo(includeSkillsRepository = false, repository?: string) {
  if (!stdin.isTTY || !stdout.isTTY)
    return

  const status = getRepoStarStatus(repository)
  if (!status.ghInstalled || !status.ghLoggedIn)
    return

  const directRepositories = [status.repository]
  if (includeSkillsRepository)
    directRepositories.push(capgoSkillsStarRepository)

  const availableDirectRepositories = directRepositories.filter((repo) => {
    const repoStatus = getRepoStarStatus(repo)
    return repoStatus.repositoryExists && !repoStatus.starred && !isRepoStarredInSession(repoStatus.repository)
  })

  if (availableDirectRepositories.length === 0 && (!status.repositoryExists || status.starred || isRepoStarredInSession(status.repository)))
    return

  const directLabel = availableDirectRepositories.length > 0
    ? `Star ${formatGithubRepositoryList(availableDirectRepositories)}`
    : `Star ${status.repository}`
  const allLabel = includeSkillsRepository
    ? 'Star all Capgo repos and Cap-go/capgo-skills'
    : 'Star all Capgo repos (repositories starting with capacitor- in Cap-go org)'

  const starChoice = await pSelect({
    message: `How would you like to support Capgo on GitHub?`,
    options: [
      { value: 'star-update', label: directLabel },
      { value: 'star-all', label: allLabel },
      { value: 'skip', label: 'No, thanks' },
    ],
  })

  if (pIsCancel(starChoice) || starChoice === 'skip') {
    return
  }

  try {
    if (starChoice === 'star-update') {
      for (const repositoryToStar of availableDirectRepositories) {
        const result = starRepository(repositoryToStar)
        if (result.alreadyStarred) {
          pLog.info(`🫶 ${result.repository} is already starred`)
        }
        else {
          pLog.success(`🙏 Thanks for starring ${result.repository} 🎉`)
        }
      }
    }
    else if (starChoice === 'star-all') {
      const result = await starAllRepositories()

      for (const repository of result) {
        if (repository.error) {
          pLog.error(`⚠️ Could not star ${repository.repository}: ${repository.error}`)
        }
        else if (repository.alreadyStarred) {
          pLog.info(`🫶 ${repository.repository} is already starred`)
        }
        else {
          pLog.success(`🙏 Thanks for starring ${repository.repository} 🎉`)
        }
      }

      if (includeSkillsRepository) {
        const skillsResult = starRepository(capgoSkillsStarRepository)
        if (skillsResult.alreadyStarred) {
          pLog.info(`🫶 ${skillsResult.repository} is already starred`)
        }
        else {
          pLog.success(`🙏 Thanks for starring ${skillsResult.repository} 🎉`)
        }
      }
    }
  }
  catch (error) {
    pLog.warn(`Cannot star ${status.repository} right now: ${formatError(error)}`)
  }
}

export async function initApp(apikeyCommand: string, appId: string, options: SuperOptions) {
  const initialCwd = cwd()
  const packageJsonPath = resolveInitTargetPath(options.packageJson, 'Package JSON path', initialCwd)
  const capacitorConfigPath = getConfigWriteTarget() ?? resolveCapacitorConfigTargetPath(options.capacitorConfig, initialCwd)
  const mainFilePath = resolveInitTargetPath(options.mainFile, 'Main file path', initialCwd)
  if (packageJsonPath && path.basename(packageJsonPath) !== PACKNAME)
    throw new Error(`Package JSON path must point to ${PACKNAME}: ${packageJsonPath}`)
  if (mainFilePath && !/\.[cm]?[jt]sx?$/.test(mainFilePath))
    throw new Error(`Main file path must point to a JavaScript or TypeScript file: ${mainFilePath}`)

  const initialTargets: InitTargetPaths = {
    pathToPackageJson: packageJsonPath,
    capacitorConfigPath,
    configLoadDir: capacitorConfigPath ? initialCwd : undefined,
    mainFilePath,
  }
  globalPathToPackageJson = initialTargets.pathToPackageJson
  globalCapacitorConfigPath = initialTargets.capacitorConfigPath
  globalConfigLoadDir = initialTargets.configLoadDir
  globalMainFilePath = initialTargets.mainFilePath
  setConfigWriteTarget(initialTargets.capacitorConfigPath)
  globalSupaHost = options.supaHost // honor --supa-host for the support-logs upload
  const pm = getPMAndCommand()
  options.apikey = apikeyCommand
  const analyticsEnabled = options.analytics !== false && !isCliTelemetryDisabled()
  startInitReplay({
    analyticsEnabled,
    apikey: options.apikey?.trim() || findSavedKeySilent(),
    supaAnon: options.supaAnon,
    supaHost: options.supaHost,
  })
  // Start the verbose internal log early so it captures the whole run (incl.
  // raw provider/API errors) and survives crashes for the support bundle.
  startInternalLog(appId || globalAppId)
  appendInternalLog(`init: onboarding started for app ${appId || globalAppId || 'unknown'}`)
  pIntro('Capgo onboarding')
  renderInitOnboardingWelcome(initOnboardingSteps.length, analyticsEnabled)

  if (!options.apikey) {
    try {
      options.apikey ??= findSavedKey(true)
    }
    catch {
    }
  }

  let resumed = await tryResumeOnboarding(options.apikey, initialTargets, initialCwd)
  let stepToSkip = resumed?.stepDone ?? 0

  await ensureGitRepoCleanBeforeInit(stepToSkip > 0 ? globalAutoTestChange : undefined)

  const initialAppId = await ensureWorkspaceReadyForInit(appId) ?? appId
  appId = initialAppId
  let selectedPackageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
  let selectedProjectDir = dirname(selectedPackageJsonPath)
  const versionStatus = await checkVersionStatus()
  if (versionStatus.isOutdated) {
    setInitVersionWarning(versionStatus.currentVersion, versionStatus.latestVersion, versionStatus.majorVersion)
  }

  let extConfig: Awaited<ReturnType<typeof getConfig>> | undefined
  const reloadSelectedProjectConfig = async () => {
    selectedPackageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
    selectedProjectDir = dirname(selectedPackageJsonPath)
    if (!options.supaAnon || !options.supaHost) {
      try {
        extConfig = await withTemporaryCwd(getInitConfigLoadDir(selectedProjectDir), () => getConfig())
      }
      catch {
        extConfig = undefined
      }
    }
    else {
      extConfig = await withTemporaryCwd(getInitConfigLoadDir(selectedProjectDir), () => updateConfigUpdater({
        statsUrl: `${options.supaHost}/functions/v1/stats`,
        channelUrl: `${options.supaHost}/functions/v1/channel_self`,
        updateUrl: `${options.supaHost}/functions/v1/updates`,
        localApiFiles: `${options.supaHost}/functions/v1`,
        localS3: true,
        localSupa: options.supaHost,
        localSupaAnon: options.supaAnon,
      }))
    }
  }
  await reloadSelectedProjectConfig()
  // Warn if this doesn't look like a Capacitor project
  const hasCapacitorConfig = Boolean(globalCapacitorConfigPath) || capacitorConfigFiles.some(file => existsSync(join(selectedProjectDir, file)))
  if (!hasCapacitorConfig) {
    pLog.warn('⚠️  No capacitor.config.* found in the selected project directory.')
    pLog.info(`   Capgo requires a Capacitor project. Selected project: ${selectedProjectDir}`)
    pLog.info('   Learn more: https://capacitorjs.com/docs/getting-started')
    const continueAnyway = await pSelect({
      message: 'Continue anyway?',
      options: [
        { value: 'yes', label: '✅ Yes, continue' },
        { value: 'no', label: '❌ No, exit' },
      ],
    })
    if (pIsCancel(continueAnyway) || continueAnyway === 'no') {
      pOutro('Bye 👋')
      return await exitAfterFinishingReplay()
    }
  }
  else {
    const availablePlatforms = getNativePlatformAvailability(extConfig?.config, selectedProjectDir)
    if (!availablePlatforms.ios && !availablePlatforms.android) {
      const { pm, capAddAndroid, capAddIos } = getInitRecoveryCommands()
      pLog.warn(`⚠️  No native platform directories found (${availablePlatforms.iosDir}/ or ${availablePlatforms.androidDir}/).`)
      pLog.info(`   Suggested commands: ${capAddIos} or ${capAddAndroid}`)
      const continueWithout = await pSelect({
        message: 'How do you want to continue?',
        options: [
          { value: 'add-ios', label: `🛠  Run ${capAddIos} now` },
          { value: 'add-android', label: `🛠  Run ${capAddAndroid} now` },
          { value: 'yes', label: '✅ Continue without native platforms' },
          { value: 'no', label: '❌ Exit onboarding' },
        ],
      })

      if (pIsCancel(continueWithout) || continueWithout === 'no') {
        pOutro(`Bye 👋\n💡 Run "${capAddIos}" or "${capAddAndroid}", then try again.`)
        return await exitAfterFinishingReplay()
      }

      if (continueWithout === 'add-ios' || continueWithout === 'add-android') {
        const platformToAdd = continueWithout === 'add-ios' ? 'ios' : 'android'
        const added = await runCapacitorPlatformAdd(platformToAdd, pm.runner, selectedProjectDir)
        if (!added) {
          const recoveryChoice = await pSelect({
            message: `Could not add ${platformToAdd}. What do you want to do next?`,
            options: [
              { value: 'retry', label: `Retry ${platformToAdd} setup` },
              { value: 'doctor', label: 'Run doctor diagnostics now' },
              { value: 'continue', label: 'Continue without native platforms' },
              { value: 'exit', label: 'Exit onboarding' },
            ],
          })

          if (pIsCancel(recoveryChoice) || recoveryChoice === 'exit') {
            pOutro(`Bye 👋\n💡 Run "${platformToAdd === 'ios' ? capAddIos : capAddAndroid}", then try again.`)
            return await exitAfterFinishingReplay()
          }

          if (recoveryChoice === 'doctor') {
            try {
              await getInfoInternal({ packageJson: globalPathToPackageJson }, false)
            }
            catch (error) {
              pLog.warn(`Doctor found an issue: ${formatError(error)}`)
            }
          }

          if (recoveryChoice === 'retry') {
            const retried = await runCapacitorPlatformAdd(platformToAdd, pm.runner, selectedProjectDir)
            if (!retried) {
              pLog.warn(`Still could not add ${platformToAdd}. Continuing without native platforms for now.`)
            }
          }
        }
      }
    }
  }

  let localConfig = await withTemporaryCwd(selectedProjectDir, () => getLocalConfig())
  appId = getAppId(initialAppId, extConfig?.config)

  appId ??= await askForAppId('Enter your appId:')

  const log = pSpinner()
  if (!doLoginExists() || apikeyCommand) {
    log.start(`Running: ${pm.runner} @capgo/cli@latest login ***`)
    try {
      await loginInternal(options.apikey, options, true)
      log.stop('Login Done ✅')
    }
    catch (error) {
      log.stop('Login failed ❌')
      throw error
    }
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await resolveUserIdFromApiKey(supabase, options.apikey)

  // A failed remote checkpoint (organization access, role, or 2FA) restarts
  // onboarding at step 0 using only the caller's original project targets.
  const discardResumedState = async () => {
    stepToSkip = 0
    resumed = undefined
    globalNodeModulesPath = undefined
    globalChannelName = defaultChannel
    globalPlatform = 'ios'
    globalDelta = false
    globalCurrentVersion = undefined
    globalAppId = undefined
    globalOrgId = undefined
    globalOrgName = undefined
    globalCodeDiff = undefined
    setInitCodeDiff(undefined)
    globalEncryptionSummary = undefined
    setInitEncryptionSummary(undefined)
    globalAutoTestChange = undefined
    cleanupStepsDone()
    globalPathToPackageJson = initialTargets.pathToPackageJson
    globalCapacitorConfigPath = initialTargets.capacitorConfigPath
    globalConfigLoadDir = initialTargets.configLoadDir
    globalMainFilePath = initialTargets.mainFilePath
    setConfigWriteTarget(initialTargets.capacitorConfigPath)
    await reloadSelectedProjectConfig()
    localConfig = await withTemporaryCwd(selectedProjectDir, () => getLocalConfig())
    appId = getAppId(initialAppId, extConfig?.config)
  }

  let organization: Organization
  if (resumed) {
    const resumedSnapshot = resumed
    // Fetch orgs to validate the saved one still exists and is accessible
    const { error: orgError, data: allOrganizations } = await supabase.rpc('get_orgs_v7')
    if (orgError || !allOrganizations) {
      pLog.error(`Cannot verify organization access: ${orgError ? JSON.stringify(orgError) : 'no data returned'}`)
      pLog.warn('Falling back to organization selection.')
      organization = await selectOrganizationForInit(supabase, options.apikey)
      await discardResumedState()
    }
    else {
      const savedOrg = allOrganizations.find(org => org.gid === resumedSnapshot.orgId)
      const blocked2fa = savedOrg?.enforcing_2fa && !savedOrg['2fa_has_access']
      const hasCreateAppPermission = savedOrg
        ? await hasCliPermission(supabase, options.apikey, 'org.create_app', { orgId: savedOrg.gid })
        : false

      if (!savedOrg) {
        pLog.warn(`Previously used organization "${resumedSnapshot.orgName}" is no longer available. Please select a new one.`)
        organization = await selectOrganizationForInit(supabase, options.apikey)
        await discardResumedState()
      }
      else if (!hasCreateAppPermission) {
        pLog.warn(`You no longer have permission to create an app in "${savedOrg.name}". Please select a different organization.`)
        organization = await selectOrganizationForInit(supabase, options.apikey)
        await discardResumedState()
      }
      else if (blocked2fa) {
        pLog.warn(`Organization "${savedOrg.name}" now requires 2FA. Enable it at ${consoleWebUrl('/settings/account')}`)
        pLog.warn('Please select a different organization or enable 2FA and try again.')
        organization = await selectOrganizationForInit(supabase, options.apikey)
        await discardResumedState()
      }
      else {
        organization = savedOrg
        pLog.info(`Using organization "${savedOrg.name}"`)
      }
    }
  }
  else {
    organization = await selectOrganizationForInit(supabase, options.apikey)
  }

  const orgId = organization.gid
  globalOrgId = orgId
  globalOrgName = organization.name

  if (resumed?.appId) {
    appId = resumed.appId
    globalAppId = appId
  }

  const pendingOnboardingSelection = await maybeReusePendingOnboardingApp(organization, options.apikey, appId, supabase, options)
  appId = pendingOnboardingSelection.appId ?? appId
  await ensureCapacitorProjectReady(orgId, options.apikey, appId, pendingOnboardingSelection.pendingApp)
  selectedPackageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
  selectedProjectDir = dirname(selectedPackageJsonPath)

  if (pendingOnboardingSelection.reusedPendingApp) {
    stepToSkip = Math.max(stepToSkip, 1)
  }
  let pkgVersion = getBundleVersion(undefined, globalPathToPackageJson) || '1.0.0'
  let delta = globalDelta
  let currentVersion = globalCurrentVersion || pkgVersion
  let channelName = globalChannelName
  let platform: 'ios' | 'android' = globalPlatform

  if (globalCurrentVersion && stepToSkip >= 3) {
    pkgVersion = globalCurrentVersion
  }

  const totalSteps = initOnboardingSteps.length
  let showResumeBanner = stepToSkip > 0

  const renderCurrentStep = (stepNumber: number) => {
    globalCurrentStepNumber = stepNumber
    renderInitOnboardingFrame(stepNumber, totalSteps, { resumed: showResumeBanner })
    showResumeBanner = false
  }

  try {
    if (stepToSkip < 1) {
      renderCurrentStep(1)
      await checkPrerequisitesStep(orgId, options.apikey)
      appId = await addAppStep(organization, options.apikey, appId, options)
      globalAppId = appId
      markStepDone(1)
    }

    if (stepToSkip < 2) {
      renderCurrentStep(2)
      channelName = await addChannelStep(orgId, options.apikey, appId)
      globalChannelName = channelName
      markStepDone(2, undefined, channelName)
    }

    if (stepToSkip < 3) {
      renderCurrentStep(3)
      const res = await addUpdaterStep(orgId, options.apikey, appId)
      pkgVersion = res.pkgVersion
      currentVersion = pkgVersion
      delta = res.delta
      globalCurrentVersion = currentVersion
      globalDelta = delta
      selectedPackageJsonPath = path.resolve(globalPathToPackageJson ?? join(findRoot(cwd()), PACKNAME))
      selectedProjectDir = dirname(selectedPackageJsonPath)
      try {
        extConfig = await withTemporaryCwd(getInitConfigLoadDir(selectedProjectDir), () => getConfig())
      }
      catch {
        extConfig = undefined
      }
      markStepDone(3)
    }

    if (stepToSkip < 4) {
      renderCurrentStep(4)
      await addCodeStep(orgId, options.apikey, appId)
      markStepDone(4)
    }

    if (stepToSkip < 5) {
      renderCurrentStep(5)
      await addEncryptionStep(orgId, options.apikey, appId)
      markStepDone(5)
    }

    // Keep the code diff visible throughout step 5 so users can reference it
    // while answering the encryption prompt. Only clear it once we move on.
    if (globalCodeDiff) {
      globalCodeDiff = undefined
      setInitCodeDiff(undefined)
    }

    if (stepToSkip < 6) {
      renderCurrentStep(6)
      platform = await selectPlatformStep(orgId, options.apikey, extConfig?.config, selectedProjectDir)
      globalPlatform = platform
      markStepDone(6)
    }

    if (stepToSkip < 7) {
      renderCurrentStep(7)
      // NOTE: we deliberately do NOT clear `globalEncryptionSummary` before
      // this step. The panel's "pending-sync" state is only resolved by a
      // successful `cap sync` inside `buildProjectStep`, which calls
      // `promoteEncryptionSummaryToEnabled()` to flip it green in place.
      // Keeping it mounted through step 7 means the user sees the status
      // change the moment sync completes, which is much clearer than a
      // panel that silently disappears.
      await buildProjectStep(orgId, options.apikey, appId, platform, extConfig?.config)
      markStepDone(7)
    }

    // Clear the encryption summary after step 7 — by this point it has
    // either been promoted to green `enabled` or it has stayed yellow
    // `pending-sync` (user declined the automatic build). Either way, the
    // next steps (device test, code change, upload) don't need it.
    if (globalEncryptionSummary) {
      globalEncryptionSummary = undefined
      setInitEncryptionSummary(undefined)
    }

    if (stepToSkip < 8) {
      renderCurrentStep(8)
      await runDeviceStep(orgId, options.apikey, appId, platform, selectedProjectDir)
      markStepDone(8)
    }

    if (stepToSkip < 9) {
      renderCurrentStep(9)
      currentVersion = await addCodeChangeStep(orgId, options.apikey, appId, pkgVersion, platform)
      globalCurrentVersion = currentVersion
      markStepDone(9)
    }

    if (stepToSkip < 10) {
      renderCurrentStep(10)
      await uploadStep(orgId, options.apikey, appId, currentVersion, delta, platform)
      markStepDone(10)
    }

    if (stepToSkip < 11) {
      renderCurrentStep(11)
      await testCapgoUpdateStep(orgId, options.apikey, appId, localConfig.hostWeb, delta)
      markStepDone(11)
    }

    if (stepToSkip < 12) {
      renderCurrentStep(12)
      await maybeOfferAutoTestCleanup(orgId, options.apikey, appId, currentVersion, platform, delta)
      markStepDone(12)
    }

    await markStep(orgId, options.apikey, 'done', appId)
    cleanupStepsDone()
  }
  catch (e) {
    const formattedError = formatError(e)
    const supportBundlePath = writeInitSupportBundle(formattedError)
    const { doctor } = getInitRecoveryCommands()

    pLog.error(`Error during onboarding: ${formattedError}`)
    if (supportBundlePath)
      pLog.error(`Support bundle saved to ${supportBundlePath}`)
    else
      pLog.error('Could not save a support bundle automatically.')
    pLog.error(`Run ${doctor} for extra diagnostics before contacting support@capgo.app`)
    pLog.error('Manual installation guide: https://capgo.app/docs/getting-started/add-an-app/')
    return await exitAfterFinishingReplay(1)
  }

  renderInitOnboardingComplete(
    appId,
    `${pm.runner} @capgo/cli@latest bundle upload --bundle <new-version> --channel ${globalChannelName}`,
    `${pm.runner} @capgo/cli@latest app debug`,
  )
  pLog.info(`If you want to run another full OTA self-test after onboarding:`)
  pLog.info(`1. Make a visible change`)
  pLog.info(`2. Build web assets only: ${pm.pm} run build`)
  pLog.info(`3. Upload with a new version: ${pm.runner} @capgo/cli@latest bundle upload --bundle <new-version> --channel ${globalChannelName}`)
  pLog.warn(`Do not run "${pm.runner} cap sync" before validating the OTA update.`)
  pLog.warn('Reason: cap sync puts your local build directly in the native app, which bypasses the Capgo OTA path.')
  pLog.info(`If you have any issue try to use the debug command \`${pm.runner} @capgo/cli@latest app debug\``)
  const didChooseSkills = await maybeInstallCapgoSkills()
  await maybeStarCapgoRepo(didChooseSkills)
  pOutro(`Bye 👋`)
  return await exitAfterFinishingReplay()
}
