import { execFileSync } from 'node:child_process'
import process from 'node:process'

type GitRunner = (args: string[]) => string

export interface DeployTag {
  isAlpha: boolean
  sha: string
  tag: string
}

const stableTagPattern = /^capgo-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const alphaTagPattern = /^capgo-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-alpha\.(?:0|[1-9]\d*)$/

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function isAlphaTag(tag: string): boolean {
  if (stableTagPattern.test(tag))
    return false
  if (alphaTagPattern.test(tag))
    return true

  throw new Error(`Malformed Capgo deployment tag: ${tag}`)
}

export function resolveDeployTag(
  tag: string,
  run: GitRunner = runGit,
): DeployTag {
  const isAlpha = isAlphaTag(tag)
  const sha = run(['rev-list', '-n', '1', tag])
  if (!/^[0-9a-f]{40,64}$/i.test(sha))
    throw new Error(`Capgo deployment tag ${tag} did not resolve to a full commit SHA`)

  return { isAlpha, sha, tag }
}

export function resolveLatestDeployTag(
  includePrereleaseTags: boolean,
  run: GitRunner = runGit,
): DeployTag {
  const output = run([
    'tag',
    '--list',
    'capgo-[0-9]*',
    '--sort=-version:refname',
    '--sort=-creatordate',
  ])
  const tags = output.split('\n').filter(Boolean)
  const tag = tags.find(candidate => includePrereleaseTags
    ? candidate.includes('-alpha.')
    : !candidate.includes('-alpha.'))

  if (!tag) {
    const environment = includePrereleaseTags ? 'alpha' : 'stable'
    throw new Error(`No ${environment} Capgo deployment tag was found`)
  }

  const expectedPattern = includePrereleaseTags ? alphaTagPattern : stableTagPattern
  if (!expectedPattern.test(tag))
    throw new Error(`Malformed Capgo deployment tag: ${tag}`)

  const sha = run(['rev-list', '-n', '1', tag])
  if (!/^[0-9a-f]{40,64}$/i.test(sha))
    throw new Error(`Capgo deployment tag ${tag} did not resolve to a full commit SHA`)

  return {
    isAlpha: includePrereleaseTags,
    sha,
    tag,
  }
}

export function assertCurrentDeployTag(
  tag: string,
  run: GitRunner = runGit,
): DeployTag {
  const target = resolveDeployTag(tag, run)
  const latest = resolveLatestDeployTag(target.isAlpha, run)

  if (latest.tag !== target.tag) {
    const environment = target.isAlpha ? 'alpha' : 'stable'
    throw new Error(`Deployment tag ${target.tag} is stale; current ${environment} tag is ${latest.tag}`)
  }

  return target
}

if (import.meta.main) {
  const mode = process.argv[2]
  const tag = process.argv[3]
  if ((mode !== '--resolve' && mode !== '--assert-current') || !tag) {
    console.error('Usage: bun scripts/resolve-deploy-tag.ts [--resolve|--assert-current] <capgo-tag>')
    process.exit(1)
  }

  const target = mode === '--resolve'
    ? resolveDeployTag(tag)
    : assertCurrentDeployTag(tag)
  console.error(`${mode === '--resolve' ? 'Resolved' : 'Validated'} deployment target: ${target.tag} (${target.sha})`)
  if (mode === '--resolve') {
    console.log(`deploy_tag=${target.tag}`)
    console.log(`deploy_sha=${target.sha}`)
    console.log(`is_alpha=${target.isAlpha}`)
  }
}
