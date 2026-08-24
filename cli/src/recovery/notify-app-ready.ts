import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { cwd } from 'node:process'
import { confirm as pConfirm, isCancel as pIsCancel, log, select as pSelect } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { findMainFile, findRoot, formatError } from '../utils'
import { checkIndexPosition, searchInDirectory } from '../bundle/check'

const NOTIFY_CALL = 'CapacitorUpdater.notifyAppReady()'
const NOTIFY_SNIPPET = `import { CapacitorUpdater } from '@capgo/capacitor-updater'\n${NOTIFY_CALL};`
export const notifyAppReadyDocsUrl = 'https://capgo.app/docs/plugins/updater/notify-app-ready/'

function readExistingMainFile(mainFilePath: string | null) {
  try {
    return mainFilePath && statSync(mainFilePath).isFile()
      ? { path: mainFilePath, content: readFileSync(mainFilePath, 'utf8') }
      : null
  }
  catch {
    return null
  }
}

function scoreBuildEntryScript(src: string, content: string): number {
  let score = 0
  const base = basename(src).toLowerCase()
  if (/polyfill|runtime|vendor|webpack|zone\.js/.test(base))
    score -= 10
  if (/^(main|index|app)\./.test(base))
    score += 5
  if (content.includes('CapacitorUpdater'))
    score += 20
  if (content.includes('notifyAppReady'))
    score += 30
  return score
}

function collectLocalScriptCandidates(webDir: string): { path: string, src: string, content: string }[] {
  const candidates: { path: string, src: string, content: string }[] = []
  const indexPath = join(webDir, 'index.html')
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8')
    const scriptMatches = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi)]
    for (const match of scriptMatches) {
      const src = match[1]?.trim()
      if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))
        continue
      const candidate = join(webDir, src.replace(/^\//, ''))
      if (existsSync(candidate) && extname(candidate) === '.js') {
        try {
          candidates.push({
            path: candidate,
            src,
            content: readFileSync(candidate, 'utf8'),
          })
        }
        catch {
          // ignore unreadable script
        }
      }
    }
  }

  if (!candidates.length) {
    const rootJsFiles = readdirSync(webDir)
      .filter(file => extname(file) === '.js')
      .map(file => join(webDir, file))
      .filter(filePath => statSync(filePath).isFile())
    for (const filePath of rootJsFiles) {
      try {
        candidates.push({
          path: filePath,
          src: basename(filePath),
          content: readFileSync(filePath, 'utf8'),
        })
      }
      catch {
        // ignore unreadable script
      }
    }
  }

  return candidates
}

export function findBuildEntryJsPath(webDir: string): string | undefined {
  const candidates = collectLocalScriptCandidates(webDir)
  if (!candidates.length)
    return undefined

  const ranked = [...candidates].sort((left, right) => {
    const scoreDelta = scoreBuildEntryScript(right.src, right.content) - scoreBuildEntryScript(left.src, left.content)
    return scoreDelta !== 0 ? scoreDelta : 0
  })

  return ranked[0]?.path
}

export function injectNotifyAppReadyIntoJs(filePath: string, content: string): string {
  if (content.includes('notifyAppReady'))
    return content

  if (content.includes('CapacitorUpdater')) {
    if (content.includes('CapacitorUpdater.notifyAppReady'))
      return content
    return `${content.trimEnd()}\n${NOTIFY_CALL};\n`
  }

  const updaterImport = extname(filePath) === '.cjs'
    ? 'const { CapacitorUpdater } = require(\'@capgo/capacitor-updater\')'
    : 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\''
  return `${updaterImport};\n\n${NOTIFY_CALL};\n${content}`
}

export function injectNotifyAppReadyIntoBuildJs(content: string): string | undefined {
  if (content.includes('notifyAppReady'))
    return content
  if (!content.includes('CapacitorUpdater'))
    return undefined
  return `${content.trimEnd()}\n${NOTIFY_CALL};\n`
}

export function patchNotifyAppReadyInBuildFolder(webDir: string): string | undefined {
  const entryPath = findBuildEntryJsPath(webDir)
  if (!entryPath)
    return undefined

  const current = readFileSync(entryPath, 'utf8')
  const updated = injectNotifyAppReadyIntoBuildJs(current)
  if (!updated)
    return undefined

  writeFileSync(entryPath, updated, 'utf8')
  return entryPath
}

export async function patchNotifyAppReadyInSourceAsync(projectRoot = findRoot(cwd())): Promise<string | undefined> {
  const directCandidates = ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/index.ts', 'src/index.tsx']
    .map(relativePath => readExistingMainFile(join(projectRoot, relativePath)))
    .find(Boolean)

  const mainFile = directCandidates ?? readExistingMainFile(await findMainFile(true, projectRoot))
  if (!mainFile)
    return undefined

  if (mainFile.content.includes('notifyAppReady'))
    return mainFile.path

  const updated = injectNotifyAppReadyIntoJs(mainFile.path, mainFile.content)
  writeFileSync(mainFile.path, updated, 'utf8')
  return mainFile.path
}

export type NotifyAppReadyRecoveryResult = 'present' | 'recovered' | 'skipped'

export interface EnsureNotifyAppReadyOptions {
  webDir: string
  interactive?: boolean
  json?: boolean
  allowSkip?: boolean
}

export function buildCiNotifyAppReadyMessage(webDir: string) {
  return [
    `notifyAppReady() is missing in the build folder (${webDir}).`,
    'Capgo needs this call when your app starts or updates may roll back.',
    `Docs: ${notifyAppReadyDocsUrl}`,
    'Fix: add CapacitorUpdater.notifyAppReady() to your app startup, rebuild, then retry.',
    'Or pass --no-code-check / --ignore-notify-app-ready only if you accept rollback risk.',
  ].join('\n')
}

export async function ensureNotifyAppReadyInBuildFolder(options: EnsureNotifyAppReadyOptions): Promise<NotifyAppReadyRecoveryResult> {
  const { webDir, interactive = false, json = false, allowSkip = true } = options

  if (!checkIndexPosition(webDir)) {
    const message = `index.html is missing in the root folder of ${webDir}`
    if (json)
      throw new Error('index_html_not_found')
    throw new Error(message)
  }

  if (searchInDirectory(webDir, 'notifyAppReady'))
    return 'present'

  if (!interactive) {
    if (json)
      throw new Error('notifyAppReady_not_in_source_code')
    throw new Error(buildCiNotifyAppReadyMessage(webDir))
  }

  while (true) {
    const choice = await pSelect({
      message: 'notifyAppReady() is missing in your build folder. How do you want to fix it?',
      options: [
        { value: 'patch-build', label: 'Patch the built output now (quick fix for zip/upload)' },
        { value: 'patch-source', label: 'Patch the app entry file, then rebuild (recommended)' },
        { value: 'manual', label: 'Show the code snippet' },
        ...(allowSkip ? [{ value: 'skip', label: 'Skip this check (updates may roll back)' }] : []),
      ],
    })

    if (pIsCancel(choice))
      throw new Error('notifyAppReady recovery cancelled')

    if (choice === 'manual') {
      log.info(`Add this where your app starts:\n\n${NOTIFY_SNIPPET}\n\nDocs: ${notifyAppReadyDocsUrl}`)
      const added = await pConfirm({ message: 'Have you added notifyAppReady() and rebuilt your app?' })
      if (pIsCancel(added) || !added)
        continue
      if (searchInDirectory(webDir, 'notifyAppReady')) {
        void trackEvent({ channel: 'bundle', event: 'CLI Recovered Missing NotifyAppReady', tags: { recovery: 'manual' } })
        return 'recovered'
      }
      log.warn('notifyAppReady() is still missing in the build folder. Rebuild, or choose another option.')
      continue
    }

    if (choice === 'skip') {
      log.warn('Skipping notifyAppReady check. Without this call, Capgo may roll back downloaded updates.')
      log.warn(`Learn more: ${notifyAppReadyDocsUrl}`)
      const confirmed = await pConfirm({
        message: 'Continue without notifyAppReady()?',
        initialValue: false,
      })
      if (pIsCancel(confirmed) || !confirmed)
        continue
      void trackEvent({ channel: 'bundle', event: 'CLI Skipped NotifyAppReady Check', tags: {} })
      return 'skipped'
    }

    if (choice === 'patch-build') {
      const patchedPath = patchNotifyAppReadyInBuildFolder(webDir)
      if (!patchedPath) {
        log.warn('Could not patch the build folder automatically. The app bundle must already include CapacitorUpdater, or patch the source and rebuild.')
        continue
      }
      if (!searchInDirectory(webDir, 'notifyAppReady')) {
        log.warn(`Patched ${patchedPath}, but notifyAppReady() is still missing. Try another option.`)
        continue
      }
      log.success(`Added notifyAppReady() to ${patchedPath}`)
      void trackEvent({ channel: 'bundle', event: 'CLI Recovered Missing NotifyAppReady', tags: { recovery: 'patch-build' } })
      return 'recovered'
    }

    if (choice === 'patch-source') {
      try {
        const patchedPath = await patchNotifyAppReadyInSourceAsync(findRoot(cwd()))
        if (!patchedPath) {
          log.warn('Could not find your app entry file automatically.')
          continue
        }
        log.success(`Added notifyAppReady() to ${patchedPath}`)
        log.info('Rebuild your web assets, then retry zip/upload.')
        const rebuilt = await pConfirm({ message: 'Have you rebuilt your app into the build folder?' })
        if (pIsCancel(rebuilt) || !rebuilt)
          continue
        if (searchInDirectory(webDir, 'notifyAppReady')) {
          void trackEvent({ channel: 'bundle', event: 'CLI Recovered Missing NotifyAppReady', tags: { recovery: 'patch-source' } })
          return 'recovered'
        }
        log.warn('notifyAppReady() is still missing in the build folder after rebuild.')
      }
      catch (error) {
        log.error(formatError(error))
      }
    }
  }
}
