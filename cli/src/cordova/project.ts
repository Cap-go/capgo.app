import type { CapacitorConfig, ExtConfigPairs } from '../config'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { DOMParser } from '@xmldom/xmldom'
import { isValidAppId } from '../recovery/app-id'

export const CORDOVA_DEFAULT_WEB_DIR = 'www'

const CORDOVA_CONFIG_FILES = ['config.xml', 'plugin.xml'] as const

export function findCordovaProjectRoot(startDir = cwd()): string {
  let current = resolve(startDir)
  const filesystemRoot = resolve(current, '/')

  while (true) {
    for (const fileName of CORDOVA_CONFIG_FILES) {
      if (existsSync(join(current, fileName)))
        return current
    }
    if (current === filesystemRoot)
      break
    current = dirname(current)
  }

  return resolve(startDir)
}

function parseXmlRootId(content: string, rootTag: 'widget' | 'plugin'): string | undefined {
  try {
    const doc = new DOMParser().parseFromString(content, 'text/xml')
    const root = doc.documentElement
    if (!root || root.nodeName.toLowerCase() !== rootTag)
      return undefined
    const candidate = root.getAttribute('id')?.trim()
    return candidate && isValidAppId(candidate) ? candidate : undefined
  }
  catch {
    return undefined
  }
}

function readCordovaAppIdFromFile(filePath: string): string | undefined {
  if (!existsSync(filePath))
    return undefined

  try {
    const content = readFileSync(filePath, 'utf8')
    if (filePath.endsWith('config.xml'))
      return parseXmlRootId(content, 'widget')
    if (filePath.endsWith('plugin.xml'))
      return parseXmlRootId(content, 'plugin')
  }
  catch {
    return undefined
  }

  return undefined
}

export function collectCordovaAppIdCandidates(projectRoot = findCordovaProjectRoot(cwd())): string[] {
  const candidates = new Set<string>()

  for (const fileName of CORDOVA_CONFIG_FILES) {
    const appId = readCordovaAppIdFromFile(join(projectRoot, fileName))
    if (appId)
      candidates.add(appId)
  }

  return [...candidates]
}

export function resolveCordovaWebDir(path?: string): string {
  return path?.trim() || CORDOVA_DEFAULT_WEB_DIR
}

export function buildCordovaUploadConfig(options: { path?: string, appId?: string }): ExtConfigPairs {
  const projectRoot = findCordovaProjectRoot()
  const detectedAppId = collectCordovaAppIdCandidates(projectRoot)[0]
  const appId = options.appId?.trim() || detectedAppId || ''
  const webDirRelative = resolveCordovaWebDir(options.path)
  const webDir = options.path?.trim()
    ? webDirRelative
    : resolve(projectRoot, webDirRelative)

  const config: CapacitorConfig = {
    appId,
    appName: 'Cordova App',
    webDir,
    plugins: {},
  }

  return {
    config,
    path: '',
  }
}
