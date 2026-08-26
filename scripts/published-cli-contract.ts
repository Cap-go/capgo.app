import { execFileSync } from 'node:child_process'
import { compare, valid as isValidSemver } from 'semver'

export const PUBLISHED_CLI_TAG_PREFIX = 'cli-'
export const PUBLISHED_CLI_TAG_PATTERN = /^cli-[0-9]/
export const PUBLISHED_CLI_RPC_PATTERN = /\.rpc\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g

export interface PublishedCliRpcCall {
  name: string
  argKeys: string[]
}

export type GitRunner = (args: string[]) => string

function defaultGitRunner(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

export function comparePublishedCliTags(left: string, right: string): number {
  const leftVersion = left.slice(PUBLISHED_CLI_TAG_PREFIX.length)
  const rightVersion = right.slice(PUBLISHED_CLI_TAG_PREFIX.length)

  if (isValidSemver(leftVersion) && isValidSemver(rightVersion))
    return compare(leftVersion, rightVersion)

  const parse = (tag: string) => tag.replace(PUBLISHED_CLI_TAG_PREFIX, '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const leftParts = parse(left)
  const rightParts = parse(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index++) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0)
      return delta
  }

  return 0
}

export function resolveLatestPublishedCliTag(runGit: GitRunner = defaultGitRunner): string {
  const output = runGit(['tag', '-l', `${PUBLISHED_CLI_TAG_PREFIX}*`])
  const tags = output
    .split('\n')
    .map(tag => tag.trim())
    .filter(tag => PUBLISHED_CLI_TAG_PATTERN.test(tag))

  if (tags.length === 0)
    throw new Error(`No published CLI tags found (expected ${PUBLISHED_CLI_TAG_PREFIX}<semver>)`)

  return tags.sort(comparePublishedCliTags).at(-1)!
}

export function resolvePublishedCliNpmVersion(tag: string): string {
  if (!PUBLISHED_CLI_TAG_PATTERN.test(tag))
    throw new Error(`Expected a published CLI tag, got ${tag}`)

  return tag.slice(PUBLISHED_CLI_TAG_PREFIX.length)
}

type NpmRunner = (args: string[]) => string

function defaultNpmRunner(args: string[]): string {
  return execFileSync('npm', args, { encoding: 'utf8' }).trim()
}

export function resolvePublishedCliNpmInstallVersion(
  tag: string,
  runNpm: NpmRunner = defaultNpmRunner,
): string {
  const targetVersion = resolvePublishedCliNpmVersion(tag)
  const publishedVersions = JSON.parse(runNpm(['view', '@capgo/cli', 'versions', '--json'])) as string[]

  if (publishedVersions.includes(targetVersion))
    return targetVersion

  const installable = publishedVersions
    .filter(version => comparePublishedCliTags(`${PUBLISHED_CLI_TAG_PREFIX}${version}`, tag) <= 0)
    .sort((left, right) => comparePublishedCliTags(`${PUBLISHED_CLI_TAG_PREFIX}${left}`, `${PUBLISHED_CLI_TAG_PREFIX}${right}`))
    .at(-1)

  if (!installable) {
    throw new Error(
      `No published @capgo/cli npm version found for git tag ${tag}. `
      + `Latest npm release is ${publishedVersions.at(-1) ?? 'unknown'}.`,
    )
  }

  return installable
}

export function resolvePublishedCliRpcSourceTag(
  latestTag: string,
  npmInstallVersion: string,
  runGit: GitRunner = defaultGitRunner,
): string {
  const latestVersion = resolvePublishedCliNpmVersion(latestTag)
  if (latestVersion === npmInstallVersion)
    return latestTag

  const installTag = `${PUBLISHED_CLI_TAG_PREFIX}${npmInstallVersion}`
  try {
    runGit(['rev-parse', '-q', '--verify', `refs/tags/${installTag}`])
    return installTag
  }
  catch {
    throw new Error(
      `Published CLI npm version ${npmInstallVersion} has no matching git tag ${installTag}. `
      + `Cannot verify RPC contract without the CLI source for the package under test.`,
    )
  }
}

export function extractArgKeysFromRpcCall(source: string, afterRpcNameIndex: number): string[] {
  let cursor = afterRpcNameIndex
  const castMatch = source.slice(cursor).match(/^\s*as\s+any/)
  if (castMatch)
    cursor += castMatch[0].length

  const remainder = source.slice(cursor).trimStart()
  if (remainder.startsWith(')'))
    return []

  const commaMatch = source.slice(cursor).match(/^\s*,/)
  if (!commaMatch)
    return []

  cursor += commaMatch[0].length
  const afterComma = source.slice(cursor).trimStart()
  if (!afterComma.startsWith('{'))
    return []

  const objectStart = source.indexOf('{', cursor)
  if (objectStart === -1)
    return []

  let depth = 0
  let inString: '"' | '\'' | '`' | null = null
  let escaped = false

  for (let index = objectStart; index < source.length; index++) {
    const char = source[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === inString)
        inString = null
      continue
    }

    if (char === '"' || char === '\'' || char === '`') {
      inString = char
      continue
    }

    if (char === '{') {
      depth++
      continue
    }

    if (char === '}') {
      depth--
      if (depth === 0) {
        const argsSource = source.slice(objectStart + 1, index)
        const keys = new Set<string>()
        for (const segment of splitTopLevelArgSegments(argsSource)) {
          const trimmed = segment.trim()
          if (!trimmed)
            continue

          const explicit = trimmed.match(/^([a-zA-Z_][\w]*)\s*:/)
          if (explicit) {
            keys.add(explicit[1]!)
            continue
          }

          const shorthand = trimmed.match(/^([a-zA-Z_][\w]*)$/)
          if (shorthand)
            keys.add(shorthand[1]!)
        }

        return [...keys].sort()
      }
    }
  }

  return []
}

function splitTopLevelArgSegments(source: string): string[] {
  const segments: string[] = []
  let start = 0
  let depth = 0
  let inString: '"' | '\'' | '`' | null = null
  let escaped = false

  for (let index = 0; index < source.length; index++) {
    const char = source[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === inString)
        inString = null
      continue
    }

    if (char === '"' || char === '\'' || char === '`') {
      inString = char
      continue
    }

    if (char === '{' || char === '[' || char === '(')
      depth++
    else if (char === '}' || char === ']' || char === ')')
      depth--
    else if (char === ',' && depth === 0) {
      segments.push(source.slice(start, index))
      start = index + 1
    }
  }

  if (start < source.length)
    segments.push(source.slice(start))

  return segments
}

function comparePublishedCliRpcCalls(left: PublishedCliRpcCall, right: PublishedCliRpcCall): number {
  const byName = left.name.localeCompare(right.name)
  if (byName !== 0)
    return byName
  return left.argKeys.join(',').localeCompare(right.argKeys.join(','))
}

function rpcNameEndIndex(source: string, match: RegExpMatchArray): number {
  return (match.index ?? 0) + match[0].length
}

export function extractPublishedCliRpcCallsFromSource(source: string): PublishedCliRpcCall[] {
  const calls = new Map<string, PublishedCliRpcCall>()

  for (const match of source.matchAll(PUBLISHED_CLI_RPC_PATTERN)) {
    const name = match[1]!
    const argKeys = extractArgKeysFromRpcCall(source, rpcNameEndIndex(source, match))
    const key = `${name}(${argKeys.join(',')})`
    calls.set(key, { name, argKeys })
  }

  return [...calls.values()].sort(comparePublishedCliRpcCalls)
}

export function extractPublishedCliRpcCalls(tag: string, runGit: GitRunner = defaultGitRunner): PublishedCliRpcCall[] {
  const output = runGit(['grep', '-l', '-E', String.raw`\.rpc\(["'\`][a-z][a-z0-9_]*["'\`]`, tag, '--', 'cli/src'])
  const files = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tagPrefix = `${tag}:`
      return line.startsWith(tagPrefix) ? line.slice(tagPrefix.length) : line
    })

  const calls = new Map<string, PublishedCliRpcCall>()
  for (const file of files) {
    const source = runGit(['show', `${tag}:${file}`])
    for (const call of extractPublishedCliRpcCallsFromSource(source)) {
      const key = `${call.name}(${call.argKeys.join(',')})`
      calls.set(key, call)
    }
  }

  return [...calls.values()].sort(comparePublishedCliRpcCalls)
}

export function formatPublishedCliRpcCall(call: PublishedCliRpcCall): string {
  if (call.argKeys.length === 0)
    return `${call.name}()`
  return `${call.name}({ ${call.argKeys.join(', ')} })`
}

export function rpcCallMatchesOverload(
  call: PublishedCliRpcCall,
  argNames: string[] | null,
  defaultCount: number,
  argCount: number,
): boolean {
  const names = argNames ?? []

  if (call.argKeys.length === 0)
    return argCount === 0 || defaultCount === argCount

  const provided = new Set(call.argKeys)
  if (!call.argKeys.every(key => names.includes(key)))
    return false

  const requiredNames = names.slice(0, Math.max(argCount - defaultCount, 0))
  return requiredNames.every(name => provided.has(name))
}
