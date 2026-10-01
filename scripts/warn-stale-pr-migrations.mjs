import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export const COMMENT_MARKER = '<!-- capgo-stale-migration-order -->'

const MIGRATIONS_PREFIX = 'supabase/migrations/'
const MIGRATION_FILE_PATTERN = /\/(\d{14})_[^/]+\.sql$/
const RECENT_ACTIVITY_HOURS = 72

export function migrationTimestamp(path) {
  return path.match(MIGRATION_FILE_PATTERN)?.[1] ?? null
}

export function latestMigrationPath(paths) {
  return paths
    .filter(path => migrationTimestamp(path))
    .toSorted((left, right) => {
      const timestampOrder = migrationTimestamp(left).localeCompare(migrationTimestamp(right))
      return timestampOrder || left.localeCompare(right)
    })
    .at(-1) ?? null
}

export function stalePullRequestMigrations(files, latestMainMigrationPath, mainMigrationPaths = [latestMainMigrationPath]) {
  const latestMainTimestamp = migrationTimestamp(latestMainMigrationPath)
  if (!latestMainTimestamp)
    return []

  const migrationFiles = files
    .filter(file => file.status === 'added' || file.status === 'renamed')
    .filter(file => file.filename.startsWith(MIGRATIONS_PREFIX) && file.filename.endsWith('.sql'))
  const addedBaselines = migrationFiles.filter(file =>
    file.status === 'added' && file.filename.endsWith('_baseline.sql'),
  )
  const removedMigrationCount = files.filter(file =>
    file.status === 'removed'
    && file.filename.startsWith(MIGRATIONS_PREFIX)
    && file.filename.endsWith('.sql'),
  ).length
  const squashBaselinePath = addedBaselines.length === 1 && removedMigrationCount >= 50
    ? addedBaselines[0].filename
    : null
  const mainTimestamps = new Set(mainMigrationPaths.map(migrationTimestamp).filter(Boolean))

  return [...new Set(migrationFiles
    .map(file => file.filename)
    .filter((path) => {
      const timestamp = migrationTimestamp(path)
      if (!timestamp || timestamp > latestMainTimestamp)
        return false

      const isAllowedSquashBaseline = path === squashBaselinePath
        && timestamp < latestMainTimestamp
        && !mainTimestamps.has(timestamp)
      return !isAllowedSquashBaseline
    }))].toSorted()
}

export function buildWarningBody({
  mainMigrationPaths,
  latestMainMigrationPath,
  staleMigrationPaths,
  commitUrl,
}) {
  const mainList = mainMigrationPaths.map(path => `- \`${path}\``).join('\n')
  const staleList = staleMigrationPaths.map(path => `- \`${path}\``).join('\n')

  return `${COMMENT_MARKER}
## ⚠️ Supabase migration order is now stale

[A push to \`main\`](${commitUrl}) added or restamped these migrations:

${mainList}

This PR still adds migrations that sort at or before the latest migration on \`main\` (\`${latestMainMigrationPath}\`):

${staleList}

The migration-order check will reject this ordering, and Supabase will not deploy this PR correctly as-is. Update the branch from \`main\`, then recreate the pending migration with a timestamp newer than the latest migration on \`main\`. If the migration has never been applied and its SQL must stay identical, use a content-preserving restamp.`
}

function localMainMigrationPaths(workspace) {
  return readdirSync(join(workspace, 'supabase', 'migrations'))
    .filter(file => file.endsWith('.sql'))
    .map(file => `${MIGRATIONS_PREFIX}${file}`)
}

export async function warnStalePrMigrations({
  github,
  context,
  core,
  mainMigrationPaths,
  latestMainMigrationPath,
  now = new Date(),
}) {
  const changedMainMigrations = mainMigrationPaths
    .map(path => path.trim())
    .filter(path => migrationTimestamp(path))
    .toSorted()

  if (changedMainMigrations.length === 0) {
    core.info('No valid Supabase migration additions were found in the main push.')
    return 0
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const currentMainMigrationPaths = localMainMigrationPaths(workspace)
  const latestMain = latestMainMigrationPath
    ?? latestMigrationPath(currentMainMigrationPaths)
  if (!latestMain)
    throw new Error('Could not determine the latest Supabase migration on main.')

  const { owner, repo } = context.repo
  const base = context.payload.repository?.default_branch ?? 'main'
  const cutoff = new Date(now.getTime() - RECENT_ACTIVITY_HOURS * 60 * 60 * 1000)
  const pullRequests = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    base,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  })
  const recentPullRequests = pullRequests.filter((pullRequest) => {
    const updatedAt = new Date(pullRequest.updated_at)
    return !Number.isNaN(updatedAt.getTime()) && updatedAt >= cutoff
  })

  let warned = 0
  for (const pullRequest of recentPullRequests) {
    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullRequest.number,
      per_page: 100,
    })
    const staleMigrationPaths = stalePullRequestMigrations(files, latestMain, currentMainMigrationPaths)
    if (staleMigrationPaths.length === 0) {
      core.info(`PR #${pullRequest.number} has no stale Supabase migrations.`)
      continue
    }

    const body = buildWarningBody({
      mainMigrationPaths: changedMainMigrations,
      latestMainMigrationPath: latestMain,
      staleMigrationPaths,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${context.sha}`,
    })
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullRequest.number,
      per_page: 100,
    })
    const existing = comments.find(comment =>
      comment.user?.login === 'github-actions[bot]'
      && comment.body?.startsWith(COMMENT_MARKER),
    )

    if (existing) {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
      core.notice(`Updated migration-order warning on PR #${pullRequest.number}.`)
    }
    else {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullRequest.number,
        body,
      })
      core.notice(`Posted migration-order warning on PR #${pullRequest.number}.`)
    }
    warned += 1
  }

  core.info(`Checked ${recentPullRequests.length} recently active PRs and warned ${warned}.`)
  return warned
}
