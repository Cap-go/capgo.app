import type { SavedCredentials } from '../schemas/build'
import type { FileHandle } from 'node:fs/promises'
import { link, mkdtemp, open, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { exit, stdout } from 'node:process'
import { confirm, log } from '@clack/prompts'
import { canPromptInteractively, formatError } from '../utils'
import { getGlobalCredentialsPath, getLocalCredentialsPath, loadSavedCredentials } from './credentials'
import { canDecodeCredentialBase64, decodeCredentialBase64 } from './credentials-base64'
import { quoteCredentialsExportTerminalValue, writeCredentialsExportStderr } from './credentials-export-terminal'

type Platform = 'ios' | 'android'
type Store = 'local' | 'global'
type CredentialsExportOptions = { appId?: string, platform?: string, local?: boolean, global?: boolean, file?: string, raw?: boolean, decodeBase64?: boolean }
type CredentialsExportStores = Record<Store, SavedCredentials | null>
type ResolvedCredentialsExport = { value: string, source: Store, platforms: Platform[] }
type FileValue = { data: string | Buffer, decoded: boolean, warnLiteral: boolean }
type FileHandleForExport = Pick<FileHandle, 'writeFile' | 'chmod' | 'close'>
type FileWriterDependencies = { mkdtemp?: typeof mkdtemp, open?: typeof open, link?: typeof link, unlink?: typeof unlink, rmdir?: typeof rmdir }

const platforms: Platform[] = ['ios', 'android']
const stores: Store[] = ['local', 'global']

export function isCredentialsExportInvocation(argv: readonly string[]): boolean {
  for (let commandIndex = 2; commandIndex < argv.length - 2; commandIndex++) {
    if (argv.slice(commandIndex, commandIndex + 3).join(' ') !== 'build credentials export')
      continue

    let index = 2
    while (index < commandIndex) {
      const token = argv[index]!
      if (token === '--capacitor-config') {
        if (index + 1 >= commandIndex)
          break
        index += 2
      }
      else if (token.startsWith('-')) {
        index++
      }
      else {
        break
      }
    }
    if (index === commandIndex)
      return true
  }
  return false
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function platformFields(saved: SavedCredentials | null, platform: Platform): Record<string, unknown> | undefined {
  const app = record(saved)
  return app && Object.hasOwn(app, platform) ? record(app[platform]) : undefined
}

function configured(saved: SavedCredentials | null, platform?: Platform): boolean {
  const fields = platform === undefined ? platforms.map(item => platformFields(saved, item)) : [platformFields(saved, platform)]
  return fields.some(field => Object.values(field ?? {}).some(value => typeof value === 'string'))
}

function storedValue(saved: SavedCredentials, platform: Platform, variable: string): string | undefined {
  const fields = platformFields(saved, platform)
  const value = fields && Object.hasOwn(fields, variable) ? fields[variable] : undefined
  return typeof value === 'string' ? value : undefined
}

const quoted = (value: string | undefined) => quoteCredentialsExportTerminalValue(value)

function resolvedFor(saved: SavedCredentials, source: Store, platform: Platform, variable: string): ResolvedCredentialsExport {
  if (!configured(saved, platform))
    throw new Error(`${platform} is not configured in the ${source} store`)
  const value = storedValue(saved, platform, variable)
  if (value === undefined)
    throw new Error(`${quoted(variable)} is not stored for ${platform} in the ${source} store`)
  return { value, source, platforms: [platform] }
}

export function resolveCredentialsExport(variable: string, options: CredentialsExportOptions, savedStores: CredentialsExportStores): ResolvedCredentialsExport {
  if (options.local && options.global)
    throw new Error('Cannot use --local and --global together')
  if (options.platform !== undefined && !platforms.includes(options.platform as Platform))
    throw new Error('--platform must be ios or android')

  const available = stores.filter(source => configured(savedStores[source]))
  const source = options.local || options.global ? options.local ? 'local' : 'global' : available[0]
  if (source === undefined)
    throw new Error(`No saved Builder credentials for ${quoted(options.appId)}`)
  if (!configured(savedStores[source]))
    throw new Error(`No saved Builder credentials for ${quoted(options.appId)} in the ${source} store`)
  if (!options.local && !options.global && available.length > 1)
    throw new Error('Saved Builder credentials exist in both stores; pass --local or --global')
  const saved = savedStores[source]!
  const selected = options.platform as Platform | undefined
  if (selected)
    return resolvedFor(saved, source, selected, variable)

  const configuredPlatforms = platforms.filter(platform => configured(saved, platform))
  if (configuredPlatforms.length === 1)
    return resolvedFor(saved, source, configuredPlatforms[0]!, variable)
  const [first, second] = configuredPlatforms
  const firstValue = storedValue(saved, first!, variable)
  const secondValue = storedValue(saved, second!, variable)
  if (firstValue !== undefined && firstValue === secondValue)
    return { value: firstValue, source, platforms: [first!, second!] }
  if (firstValue === undefined && secondValue === undefined)
    throw new Error(`${quoted(variable)} is not stored for ios or android in the ${source} store`)
  throw new Error(`${quoted(variable)} is ambiguous across ios and android; pass --platform`)
}

export async function resolveCredentialsFileValue(variable: string, value: string, { decodeBase64, interactive, promptDecode }: { decodeBase64?: boolean, interactive: boolean, promptDecode: () => Promise<boolean | symbol> }): Promise<FileValue> {
  if (decodeBase64)
    return { data: decodeCredentialBase64(value), decoded: true, warnLiteral: false }
  if (!canDecodeCredentialBase64(variable, value))
    return { data: value, decoded: false, warnLiteral: false }
  if (!interactive)
    return { data: value, decoded: false, warnLiteral: true }
  const answer = await promptDecode()
  if (typeof answer === 'symbol')
    throw new Error('Credential export canceled')
  return answer
    ? { data: decodeCredentialBase64(value), decoded: true, warnLiteral: false }
    : { data: value, decoded: false, warnLiteral: true }
}

export async function writeCredentialsExportFile(path: string, data: string | Buffer, { mkdtemp: makeTemp = mkdtemp, open: openFile = open, link: publish = link, unlink: removeFile = unlink, rmdir: removeDir = rmdir }: FileWriterDependencies = {}): Promise<void> {
  let tempDir: string | undefined
  let tempPath: string | undefined
  let handle: FileHandleForExport | undefined
  let failure: unknown
  let cleanupFailed = false
  let published = false
  const close = async () => {
    if (!handle)
      return
    await handle.close()
    handle = undefined
  }
  try {
    tempDir = await makeTemp(join(dirname(path), '.capgo-export-'))
    tempPath = join(tempDir, 'credential')
    handle = await openFile(tempPath, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.chmod(0o600)
    await close()
    await publish(tempPath, path)
    published = true
  }
  catch (error) {
    failure = error
  }
  finally {
    try {
      await close()
    }
    catch {
      cleanupFailed = true
    }
    let fileRemoved = false
    if (tempPath) {
      try {
        await removeFile(tempPath)
        fileRemoved = true
      }
      catch (error) {
        fileRemoved = (error as NodeJS.ErrnoException).code === 'ENOENT'
        cleanupFailed ||= !fileRemoved
      }
    }
    if (tempDir && fileRemoved) {
      try {
        await removeDir(tempDir)
      }
      catch {
        cleanupFailed = true
      }
    }
  }
  if (failure === undefined && !cleanupFailed)
    return
  if (cleanupFailed)
    throw new Error(`Cannot safely clean up temporary credential export directory ${quoted(tempDir)}. Destination ${published ? 'was created.' : 'was not replaced or created.'}`)
  if ((failure as NodeJS.ErrnoException | undefined)?.code === 'EEXIST')
    throw new Error(`Destination already exists: ${quoted(path)}`)
  throw new Error(`Cannot write credential export file: ${quoted(path)}`)
}

function validateCredentialsExportInput(variable: string | undefined, options: CredentialsExportOptions): void {
  if (!variable)
    throw new Error('Variable is required')
  if (!options.appId)
    throw new Error('--app-id <APP_ID> is required')
  if (options.local && options.global)
    throw new Error('Cannot use --local and --global together')
  if (options.platform !== undefined && options.platform !== 'ios' && options.platform !== 'android')
    throw new Error('--platform must be ios or android')
  const hasFile = options.file !== undefined
  if (Boolean(options.raw) === hasFile)
    throw new Error('Pass exactly one of --raw or --file <PATH>')
  if (options.file === '')
    throw new Error('--file <PATH> must not be empty')
  if (options.decodeBase64 && options.raw)
    throw new Error('--decode-base64 cannot be used with --raw')
  if (options.file === '-')
    throw new Error('--file - is not supported; use --raw for stdout')
}

export async function exportCredentialsCommand(variable: string | undefined, options: CredentialsExportOptions): Promise<void> {
  try {
    validateCredentialsExportInput(variable, options)
    const exportVariable = variable!

    const stores = options.local
      ? { local: await loadSavedCredentials(options.appId, true, true), global: null }
      : options.global
        ? { local: null, global: await loadSavedCredentials(options.appId, false, true) }
        : {
            local: await loadSavedCredentials(options.appId, true, true),
            global: await loadSavedCredentials(options.appId, false, true),
          }
    const resolved = resolveCredentialsExport(exportVariable, options, stores)
    if (options.raw) {
      stdout.write(resolved.value)
      return
    }

    const fileValue = await resolveCredentialsFileValue(exportVariable, resolved.value, {
      decodeBase64: options.decodeBase64,
      interactive: canPromptInteractively(),
      promptDecode: () => confirm({ message: `${quoted(exportVariable)} looks like Base64. Decode it before writing the file?` }),
    })
    const destination = resolve(options.file!)
    await writeCredentialsExportFile(destination, fileValue.data)
    if (fileValue.warnLiteral)
      log.warn('Saved the stored Base64 text without decoding it. Pass --decode-base64 to write decoded bytes.')
    const sourcePath = resolved.source === 'local' ? getLocalCredentialsPath() : getGlobalCredentialsPath()
    log.success(`Exported ${quoted(exportVariable)} from ${resolved.source} ${resolved.platforms.join('/')} credentials (${quoted(sourcePath)}) to ${quoted(destination)} as ${fileValue.decoded ? 'decoded bytes' : 'stored text'}.`)
  }
  catch (error) {
    await writeCredentialsExportStderr(`${formatError(error)}\n`).catch(() => {})
    exit(1)
  }
}
