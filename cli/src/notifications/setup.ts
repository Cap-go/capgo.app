import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cwd } from 'node:process'
import { intro, log, outro, spinner } from '@clack/prompts'
import { formatRunnerCommand, splitRunnerCommand } from '../runner-command'
import { defaultApiHost, formatError, getConfig, getPMAndCommand, updateConfigbyKey } from '../utils'
import { writeFileAtomic } from '../utils/safeWrites'

const notificationPackages = [
  '@capgo/capacitor-notifications',
  '@capgo/capacitor-updater',
]

interface NotificationSetupOptions {
  serverUrl?: string
  file?: string
  force?: boolean
  install?: boolean
  sync?: boolean
}

function getConfigAppId(config: Awaited<ReturnType<typeof getConfig>>) {
  return String(config.config?.plugins?.CapacitorUpdater?.appId || config.config?.appId || '')
}

function renderNotificationHelper(appId: string, serverUrl: string) {
  const appIdLiteral = JSON.stringify(appId)
  const serverUrlLiteral = JSON.stringify(serverUrl)

  return `import { CapgoNotifications } from '@capgo/capacitor-notifications'

export interface CapgoNotificationIdentity {
  externalId: string
  identityProof: string
  tags?: string[]
  attributes?: Record<string, unknown>
  consent?: boolean
}

export async function setupCapgoNotifications(identity: CapgoNotificationIdentity) {
  if (!identity.externalId)
    return
  if (!identity.identityProof)
    throw new Error('Capgo notification identityProof is required')

  await CapgoNotifications.configure({
    appId: ${appIdLiteral},
    serverUrl: ${serverUrlLiteral},
  })

  return CapgoNotifications.register({
    externalId: identity.externalId,
    identityProof: identity.identityProof,
    tags: identity.tags ?? [],
    attributes: identity.attributes ?? {},
    consent: identity.consent ?? true,
  })
}

export { CapgoNotifications }
`
}

function runCommand(command: string, args: string[], failureMessage: string) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error(`${failureMessage} exited with code ${result.status}`)
}

function runInstall() {
  const pm = getPMAndCommand()
  log.info(`Installing notification packages with ${pm.installCommand}`)
  runCommand(pm.pm, [pm.command, ...notificationPackages], 'Notification package install')
}

function runSync() {
  const pm = getPMAndCommand()
  const runner = splitRunnerCommand(pm.runner)
  const displayCommand = formatRunnerCommand(pm.runner, ['cap', 'sync'])
  log.info(`Running ${displayCommand}`)
  runCommand(runner.command, [...runner.args, 'cap', 'sync'], 'Capacitor sync')
}

function assertHelperFileWritable(filePath: string, force: boolean | undefined) {
  const absolutePath = resolve(cwd(), filePath)
  if (existsSync(absolutePath) && !force)
    throw new Error(`${filePath} already exists. Re-run with --force to overwrite it.`)
  return absolutePath
}

async function writeHelperFile(filePath: string, appId: string, serverUrl: string, force: boolean | undefined) {
  const absolutePath = assertHelperFileWritable(filePath, force)
  mkdirSync(dirname(absolutePath), { recursive: true })
  await writeFileAtomic(absolutePath, renderNotificationHelper(appId, serverUrl), { mode: 0o644 })
  return absolutePath
}

export async function setupNotifications(appIdArg: string | undefined, options: NotificationSetupOptions) {
  intro('Capgo native notifications setup')
  const progress = spinner()

  try {
    const config = await getConfig()
    const appId = appIdArg || getConfigAppId(config)
    if (!appId)
      throw new Error('Missing appId. Pass it as `notifications setup com.example.app` or set it in capacitor.config.')

    const serverUrl = options.serverUrl || defaultApiHost
    const helperFile = options.file || 'src/capgo-notifications.ts'
    assertHelperFileWritable(helperFile, options.force)

    if (options.install !== false)
      runInstall()

    progress.start('Saving Capacitor notification config')
    await updateConfigbyKey('CapgoNotifications', { appId, serverUrl })
    progress.stop('Capacitor notification config saved')

    const writtenPath = await writeHelperFile(helperFile, appId, serverUrl, options.force)
    log.success(`Created ${writtenPath}`)

    if (options.sync !== false)
      runSync()

    log.info('Import setupCapgoNotifications(...) after your user is known, and pass your stable customer external ID.')
    log.info('Then configure Android and iOS push credentials in the Capgo app Notifications tab before sending production notifications.')
    outro('Notifications setup done')
  }
  catch (error) {
    progress.stop('Notifications setup failed')
    log.error(formatError(error))
    throw error
  }
}

export { renderNotificationHelper }
