import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import * as warningModule from '../scripts/warn-stale-pr-migrations.mjs'

interface PullRequestFile {
  filename: string
  status: string
}

describe('stale pull request migration warnings', () => {
  it.concurrent('detects only added or restamped migrations that no longer sort after main', () => {
    const latestMain = 'supabase/migrations/20261001093410_latest.sql'
    const files = [
      { filename: 'supabase/migrations/20261001090000_stale.sql', status: 'added' },
      { filename: 'supabase/migrations/20261001093410_duplicate.sql', status: 'renamed' },
      { filename: 'supabase/migrations/20261001100000_fresh.sql', status: 'added' },
      { filename: 'supabase/migrations/20260930000000_existing.sql', status: 'modified' },
      { filename: 'src/example.ts', status: 'added' },
    ]

    expect(warningModule.stalePullRequestMigrations(files, latestMain)).toEqual([
      'supabase/migrations/20261001090000_stale.sql',
      'supabase/migrations/20261001093410_duplicate.sql',
    ])
    expect(warningModule.latestMigrationPath([
      'supabase/migrations/20261001090000_old.sql',
      latestMain,
      'supabase/migrations/not-a-migration.sql',
    ])).toBe(latestMain)
  })

  it.concurrent('allows a unique older baseline for an intentional migration squash', () => {
    const latestMain = 'supabase/migrations/20261001093410_latest.sql'
    const olderMain = 'supabase/migrations/20260930000000_existing.sql'
    const squashFiles: PullRequestFile[] = [
      { filename: 'supabase/migrations/20260929000000_schema_baseline.sql', status: 'added' },
      ...Array.from({ length: 50 }, (_, index) => ({
        filename: `supabase/migrations/202608${String(index + 1).padStart(2, '0')}000000_old.sql`,
        status: 'removed',
      })),
    ]

    expect(warningModule.stalePullRequestMigrations(
      squashFiles,
      latestMain,
      [olderMain, latestMain],
    )).toEqual([])

    expect(warningModule.stalePullRequestMigrations(
      [
        ...squashFiles.filter(file => file.status === 'removed'),
        { filename: olderMain.replace('_existing.sql', '_schema_baseline.sql'), status: 'added' },
      ],
      latestMain,
      [olderMain, latestMain],
    )).toEqual([
      'supabase/migrations/20260930000000_schema_baseline.sql',
    ])
  })

  it.concurrent('warns only recently active affected PRs and upserts the workflow comment', async () => {
    const pullsList = vi.fn()
    const listFiles = vi.fn()
    const listComments = vi.fn()
    const createComment = vi.fn()
    const deleteComment = vi.fn()
    const updateComment = vi.fn()
    const pullRequests = [
      { number: 10, updated_at: '2026-10-01T10:00:00Z' },
      { number: 11, updated_at: '2026-09-27T10:00:00Z' },
      { number: 12, updated_at: '2026-10-01T09:00:00Z' },
    ]
    const files = new Map([
      [10, [{ filename: 'supabase/migrations/20261001090000_stale.sql', status: 'added' }]],
      [12, [{ filename: 'supabase/migrations/20261001110000_fresh.sql', status: 'added' }]],
    ])
    const github = {
      paginate: vi.fn(async (method, input: { pull_number?: number }) => {
        if (method === pullsList)
          return pullRequests
        if (method === listFiles)
          return files.get(input.pull_number ?? -1) ?? []
        if (method === listComments)
          return [{ id: 99, body: `${warningModule.COMMENT_MARKER}\nold`, user: { login: 'github-actions[bot]' } }]
        return []
      }),
      rest: {
        issues: { createComment, deleteComment, listComments, updateComment },
        pulls: { list: pullsList, listFiles },
      },
    }
    const core = { info: vi.fn(), notice: vi.fn() }

    const warned = await warningModule.warnStalePrMigrations({
      github,
      context: {
        payload: { repository: { default_branch: 'main' } },
        repo: { owner: 'Cap-go', repo: 'capgo.app' },
        sha: 'abc123',
      },
      core,
      mainMigrationPaths: ['supabase/migrations/20261001093410_latest.sql'],
      latestMainMigrationPath: 'supabase/migrations/20261001093410_latest.sql',
      now: new Date('2026-10-01T12:00:00Z'),
    })

    expect(warned).toBe(1)
    expect(updateComment).toHaveBeenCalledOnce()
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      comment_id: 99,
      body: expect.stringContaining('Supabase will not deploy this PR correctly as-is'),
    }))
    expect(createComment).not.toHaveBeenCalled()
    expect(deleteComment).toHaveBeenCalledOnce()
    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }))
    expect(github.paginate.mock.calls.filter(([method]) => method === listFiles)).toHaveLength(2)
  })

  it.concurrent('creates a marker comment when a stale PR has no prior warning', async () => {
    const pullsList = vi.fn()
    const listFiles = vi.fn()
    const listComments = vi.fn()
    const createComment = vi.fn()
    const github = {
      paginate: vi.fn(async (method) => {
        if (method === pullsList)
          return [{ number: 20, updated_at: '2026-10-01T10:00:00Z' }]
        if (method === listFiles)
          return [{ filename: 'supabase/migrations/20261001090000_stale.sql', status: 'added' }]
        return []
      }),
      rest: {
        issues: { createComment, deleteComment: vi.fn(), listComments, updateComment: vi.fn() },
        pulls: { list: pullsList, listFiles },
      },
    }

    const warned = await warningModule.warnStalePrMigrations({
      github,
      context: {
        payload: { repository: { default_branch: 'main' } },
        repo: { owner: 'Cap-go', repo: 'capgo.app' },
        sha: 'abc123',
      },
      core: { info: vi.fn(), notice: vi.fn() },
      mainMigrationPaths: ['supabase/migrations/20261001093410_latest.sql'],
      latestMainMigrationPath: 'supabase/migrations/20261001093410_latest.sql',
      now: new Date('2026-10-01T12:00:00Z'),
    })

    expect(warned).toBe(1)
    expect(createComment).toHaveBeenCalledOnce()
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 20,
      body: expect.stringContaining(warningModule.COMMENT_MARKER),
    }))
  })

  it.concurrent('configures the workflow for main migration pushes with comment permissions', async () => {
    const source = await readFile(new URL('../.github/workflows/warn-stale-pr-migrations.yml', import.meta.url), 'utf8')
    const workflow = parse(source) as {
      jobs: Record<string, {
        concurrency?: { 'group': string, 'cancel-in-progress': boolean, 'queue': string }
        steps: Array<Record<string, unknown>>
      }>
      on: { push: { branches: string[], paths: string[] } }
      permissions: Record<string, string>
    }

    expect(workflow.on.push.branches).toEqual(['main'])
    expect(workflow.on.push.paths).toEqual(['supabase/migrations/*.sql'])
    expect(workflow.permissions).toMatchObject({
      'contents': 'read',
      'issues': 'write',
      'pull-requests': 'write',
    })
    expect(workflow.jobs.warn.concurrency).toEqual({
      'group': 'warn-stale-pr-migrations-main',
      'cancel-in-progress': false,
      'queue': 'max',
    })
    const steps = workflow.jobs.warn.steps
    expect(steps.find(step => step.name === 'Checkout main')).toMatchObject({
      uses: 'actions/checkout@v6',
      with: { 'fetch-depth': 0 },
    })
    const findStep = steps.find(step => step.name === 'Find migrations added to main')
    expect(findStep?.run).toContain('-M100%')
    expect(findStep?.run).toContain('--diff-filter=AR')
    expect(findStep?.run).toContain('git rev-parse --verify --quiet "$BEFORE_SHA^{commit}"')
    expect(steps.find(step => step.name === 'Warn affected pull requests')?.uses).toBe('actions/github-script@v8')
  })
})
