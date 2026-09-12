import { execFileSync } from 'node:child_process'
import process from 'node:process'

type GitRunner = (args: string[]) => string

export interface PublishSchemaTypesOptions {
  branch: string
  expectedBranchSha: string
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

function validateOptions(options: PublishSchemaTypesOptions): void {
  if (!isValidRefName(options.branch))
    throw new Error(`Invalid schema/types branch: ${options.branch}`)
  if (!/^[0-9a-f]{40,64}$/i.test(options.expectedBranchSha))
    throw new Error('Expected schema/types branch SHA must be a full hexadecimal object ID')
  if (!options.remote || /[\r\n]/.test(options.remote) || options.remote.startsWith('-'))
    throw new Error('Schema/types remote must be non-empty, contain no line breaks, and not start with "-"')
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

export function publishSchemaTypes(
  options: PublishSchemaTypesOptions,
  run: GitRunner = runGit,
): 'published' | 'retry' {
  validateOptions(options)

  const remoteSha = readRemoteBranchSha(options.remote, options.branch, run)
  if (remoteSha !== options.expectedBranchSha)
    return 'retry'

  try {
    run([
      'push',
      '--atomic',
      options.remote,
      `HEAD:refs/heads/${options.branch}`,
    ])
    return 'published'
  }
  catch (error) {
    try {
      const remoteShaAfterFailure = readRemoteBranchSha(options.remote, options.branch, run)
      const localHead = run(['rev-parse', 'HEAD'])

      if (remoteShaAfterFailure === localHead)
        return 'published'
      if (remoteShaAfterFailure !== options.expectedBranchSha)
        return 'retry'
    }
    catch {
      // Preserve the original push failure when remote state cannot be verified.
    }

    throw error
  }
}

if (import.meta.main) {
  const branch = process.argv[2] ?? ''
  const expectedBranchSha = process.argv[3] ?? ''
  const remote = process.env.SCHEMA_TYPES_REMOTE_URL ?? ''

  if (!branch || !expectedBranchSha || !remote) {
    console.error('Usage: SCHEMA_TYPES_REMOTE_URL=<remote> bun scripts/publish-schema-types.ts <branch> <expected-branch-sha>')
    process.exit(1)
  }

  console.log(publishSchemaTypes({ branch, expectedBranchSha, remote }))
}
