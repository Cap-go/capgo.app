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

if (import.meta.main) {
  const mode = process.argv[2] ?? '--stable'
  if (mode !== '--stable' && mode !== '--alpha') {
    console.error('Usage: bun scripts/resolve-deploy-tag.ts [--stable|--alpha]')
    process.exit(1)
  }

  const target = resolveLatestDeployTag(mode === '--alpha')
  console.error(`Resolved deployment target: ${target.tag} (${target.sha})`)
  console.log(`deploy_tag=${target.tag}`)
  console.log(`deploy_sha=${target.sha}`)
  console.log(`is_alpha=${target.isAlpha}`)
}
