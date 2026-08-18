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

function hasUnescapedDollar(value: string): boolean {
  let escaped = false

  for (const character of value) {
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '$')
      return true
  }

  return false
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
      throw new Error(`versionName in ${buildGradlePath} must be a standalone quoted string literal`)

    const start = cursor + 1
    let escaped = false
    let end: number | undefined
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
        end = cursor
        break
      }
      cursor += 1
    }

    if (end === undefined)
      throw new Error(`versionName in ${buildGradlePath} must be a standalone quoted string literal`)

    if (quote === '"' && hasUnescapedDollar(content.slice(start, end)))
      throw new Error(`versionName in ${buildGradlePath} must be a standalone quoted string literal`)

    let trailingCursor = end + 1
    while (masked[trailingCursor] === ' ' || masked[trailingCursor] === '\t')
      trailingCursor += 1
    const trailingCharacter = masked[trailingCursor]
    if (trailingCharacter !== undefined
      && trailingCharacter !== '\n'
      && trailingCharacter !== '\r'
      && trailingCharacter !== ';'
      && trailingCharacter !== '}') {
      throw new Error(`versionName in ${buildGradlePath} must be a standalone quoted string literal`)
    }

    ranges.push({ start, end })
  }

  if (ranges.length === 0)
    throw new Error(`versionName in ${buildGradlePath} must be a standalone quoted string literal`)

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
