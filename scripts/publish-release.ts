import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

type GitRunner = (args: string[]) => string

export interface PublishReleaseOptions {
  branch: string
  expectedBranchSha: string
  knownTags: readonly string[]
  remote: string
}

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function isValidRefName(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && !value.startsWith('.')
    && !value.endsWith('.')
    && !value.endsWith('/')
    && !value.endsWith('.lock')
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !/[\x00-\x20\x7F~^:?*[\\]/.test(value)
    && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
}

function validateOptions(options: PublishReleaseOptions): void {
  if (!isValidRefName(options.branch))
    throw new Error(`Invalid release branch: ${options.branch}`)
  if (!/^[0-9a-f]{40,64}$/i.test(options.expectedBranchSha))
    throw new Error('Expected branch SHA must be a full hexadecimal object ID')
  if (!options.remote || /[\r\n]/.test(options.remote))
    throw new Error('Release remote must be non-empty and contain no line breaks')
  for (const tag of options.knownTags) {
    if (!isValidRefName(tag))
      throw new Error(`Invalid known release tag: ${tag}`)
  }
}

function readRemoteBranchSha(remote: string, branch: string, run: GitRunner): string {
  const ref = `refs/heads/${branch}`
  const output = run(['ls-remote', '--heads', remote, ref])
  const [line, ...extraLines] = output.split('\n').filter(Boolean)
  const match = line?.match(/^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/i)

  if (!match || extraLines.length > 0 || match[2] !== branch)
    throw new Error(`Could not resolve remote branch ${ref}`)

  return match[1]
}

function getNewTags(knownTags: readonly string[], run: GitRunner): string[] {
  const known = new Set(knownTags)
  const output = run(['tag', '--list'])
  const newTags = output.split('\n').filter(Boolean).filter(tag => !known.has(tag))

  for (const tag of newTags) {
    if (!isValidRefName(tag))
      throw new Error(`Invalid new release tag: ${tag}`)
  }

  return newTags
}

function readRemoteTagSha(remote: string, tag: string, run: GitRunner): string | null {
  const ref = `refs/tags/${tag}`
  const output = run(['ls-remote', '--refs', '--tags', remote, ref])
  const [line, ...extraLines] = output.split('\n').filter(Boolean)
  const match = line?.match(/^([0-9a-f]{40,64})\trefs\/tags\/(.+)$/i)

  if (!match || extraLines.length > 0 || match[2] !== tag)
    return null

  return match[1]
}

function remoteTagsMatchLocal(
  remote: string,
  newTags: readonly string[],
  run: GitRunner,
): boolean {
  for (const tag of newTags) {
    const localTagSha = run(['rev-parse', `refs/tags/${tag}`])
    const remoteTagSha = readRemoteTagSha(remote, tag, run)
    if (!remoteTagSha || remoteTagSha !== localTagSha)
      return false
  }

  return true
}

export function publishReleaseAtomically(
  options: PublishReleaseOptions,
  run: GitRunner = runGit,
): 'published' | 'superseded' {
  validateOptions(options)

  const remoteSha = readRemoteBranchSha(options.remote, options.branch, run)
  if (remoteSha !== options.expectedBranchSha)
    return 'superseded'

  const newTags = getNewTags(options.knownTags, run)
  const pushArgs = [
    'push',
    '--atomic',
    options.remote,
    `HEAD:refs/heads/${options.branch}`,
    ...newTags.map(tag => `refs/tags/${tag}:refs/tags/${tag}`),
  ]

  try {
    run(pushArgs)
    return 'published'
  }
  catch (error) {
    try {
      const remoteSha = readRemoteBranchSha(options.remote, options.branch, run)
      const localHead = run(['rev-parse', 'HEAD'])

      if (remoteSha === localHead && remoteTagsMatchLocal(options.remote, newTags, run))
        return 'published'
      if (remoteSha !== localHead && remoteSha !== options.expectedBranchSha)
        return 'superseded'
    }
    catch {
      // Preserve the original push failure when the remote state cannot be fully verified.
    }

    throw error
  }
}

if (import.meta.main) {
  const branch = process.argv[2] ?? ''
  const expectedBranchSha = process.argv[3] ?? ''
  const knownTagsPath = process.argv[4] ?? ''
  const remote = process.env.RELEASE_REMOTE_URL ?? ''

  if (!branch || !expectedBranchSha || !knownTagsPath || !remote) {
    console.error('Usage: RELEASE_REMOTE_URL=<remote> bun scripts/publish-release.ts <branch> <expected-branch-sha> <known-tags-file>')
    process.exit(1)
  }

  const knownTags = readFileSync(knownTagsPath, 'utf8').split('\n').filter(Boolean)
  const status = publishReleaseAtomically({ branch, expectedBranchSha, knownTags, remote })

  if (status === 'superseded')
    console.error(`Release publication was superseded because ${branch} advanced after this run started.`)
  console.log(status)
}
