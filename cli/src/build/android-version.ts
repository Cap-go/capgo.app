import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface SyncAndroidVersionOptions {
  path?: string
}

export interface SyncAndroidVersionResult {
  projectDir: string
  packageJsonPath: string
  buildGradlePath: string
  packageVersion: string
  replacements: number
  changed: boolean
}

interface StringLiteralRange {
  start: number
  end: number
}

function maskGradleComments(content: string): string {
  const masked = content.split('')
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    const nextCharacter = content[index + 1]

    if (quote) {
      if (escaped) {
        masked[index] = ' '
        escaped = false
        continue
      }
      if (character === '\\') {
        masked[index] = ' '
        escaped = true
        continue
      }
      if (character === quote) {
        quote = null
      }
      else {
        masked[index] = ' '
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === '/' && nextCharacter === '/') {
      while (index < content.length && content[index] !== '\n') {
        masked[index] = ' '
        index += 1
      }
      index -= 1
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      masked[index] = ' '
      masked[index + 1] = ' '
      index += 2
      while (index < content.length) {
        if (content[index] === '*' && content[index + 1] === '/') {
          masked[index] = ' '
          masked[index + 1] = ' '
          index += 1
          break
        }
        if (content[index] !== '\n' && content[index] !== '\r')
          masked[index] = ' '
        index += 1
      }
    }
  }

  return masked.join('')
}

function findVersionNameStringLiterals(content: string, buildGradlePath: string): StringLiteralRange[] {
  const masked = maskGradleComments(content)
  const ranges: StringLiteralRange[] = []

  for (const match of masked.matchAll(/\bversionName\b/g)) {
    let cursor = match.index + match[0].length
    while (/\s/.test(masked[cursor] ?? ''))
      cursor += 1
    if (masked[cursor] === '=') {
      cursor += 1
      while (/\s/.test(masked[cursor] ?? ''))
        cursor += 1
    }

    const quote = masked[cursor]
    if (quote !== '"' && quote !== "'")
      throw new Error(`versionName in ${buildGradlePath} must be a quoted string`)

    const start = cursor + 1
    let escaped = false
    cursor = start
    while (cursor < masked.length) {
      const character = masked[cursor]
      if (escaped) {
        escaped = false
      }
      else if (character === '\\') {
        escaped = true
      }
      else if (character === quote) {
        ranges.push({ start, end: cursor })
        break
      }
      cursor += 1
    }

    if (ranges.at(-1)?.start !== start)
      throw new Error(`versionName in ${buildGradlePath} must be a quoted string`)
  }

  if (ranges.length === 0)
    throw new Error(`versionName in ${buildGradlePath} must be a quoted string`)

  return ranges
}

export function syncAndroidVersion(options: SyncAndroidVersionOptions = {}): SyncAndroidVersionResult {
  const projectDir = resolve(options.path ?? process.cwd())
  const packageJsonPath = join(projectDir, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
  const packageVersion = packageJson.version

  if (!packageVersion)
    throw new Error(`${packageJsonPath} is missing version`)

  const buildGradlePath = join(projectDir, 'android', 'app', 'build.gradle')
  if (!existsSync(buildGradlePath))
    throw new Error(`Android build.gradle not found at ${buildGradlePath}`)

  const content = readFileSync(buildGradlePath, 'utf8')
  const literalRanges = findVersionNameStringLiterals(content, buildGradlePath)
  let updated = content
  for (const range of literalRanges.toReversed())
    updated = `${updated.slice(0, range.start)}${packageVersion}${updated.slice(range.end)}`
  const replacements = literalRanges.length
  const changed = updated !== content

  if (changed)
    writeFileSync(buildGradlePath, updated, 'utf8')

  return {
    projectDir,
    packageJsonPath,
    buildGradlePath,
    packageVersion,
    replacements,
    changed,
  }
}
