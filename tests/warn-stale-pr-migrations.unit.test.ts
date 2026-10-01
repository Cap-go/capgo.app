import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it.concurrent('escapes migration paths embedded in the bot comment', () => {
    const body = warningModule.buildWarningBody({
      commitUrl: 'https://github.com/Cap-go/capgo.app/commit/abc123',
      latestMainMigrationPath: 'supabase/migrations/20261001093410_latest.sql',
      mainMigrationPaths: ['supabase/migrations/20261001093410_`main<.sql'],
      staleMigrationPaths: ['supabase/migrations/20261001090000_`stale>.sql'],
    })

    expect(body).not.toContain('`stale>')
    expect(body).toContain('<code>supabase/migrations/20261001090000_`stale&gt;.sql</code>')
    expect(body).toContain('<code>supabase/migrations/20261001093410_`main&lt;.sql</code>')
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
      currentMainMigrationPaths: ['supabase/migrations/20261001093410_latest.sql'],
      mainMigrationPaths: ['supabase/migrations/20261001093410_latest.sql'],
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
      paginate: vi.fn(async (method, input: { pull_number?: number }) => {
        if (method === pullsList) {
          return [
            { number: 19, updated_at: '2026-10-01T10:30:00Z' },
            { number: 20, updated_at: '2026-10-01T10:00:00Z' },
          ]
        }
        if (method === listFiles && input.pull_number === 19)
          throw new Error('temporary API failure')
        if (method === listFiles && input.pull_number === 20)
          return [{ filename: 'supabase/migrations/20261001090000_stale.sql', status: 'added' }]
        return []
      }),
      rest: {
        issues: { createComment, deleteComment: vi.fn(), listComments, updateComment: vi.fn() },
        pulls: { list: pullsList, listFiles },
      },
    }

    const core = { info: vi.fn(), notice: vi.fn(), warning: vi.fn() }
    const warned = await warningModule.warnStalePrMigrations({
      github,
      context: {
        payload: { repository: { default_branch: 'main' } },
        repo: { owner: 'Cap-go', repo: 'capgo.app' },
        sha: 'abc123',
      },
      core,
      currentMainMigrationPaths: ['supabase/migrations/20261001120000_current-main.sql'],
      mainMigrationPaths: ['supabase/migrations/20261001093410_latest.sql'],
      now: new Date('2026-10-01T12:00:00Z'),
    })

    expect(warned).toBe(1)
    expect(createComment).toHaveBeenCalledOnce()
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 20,
      body: expect.stringContaining(warningModule.COMMENT_MARKER),
    }))
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('20261001120000_current-main.sql'),
    }))
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('PR #19: temporary API failure'))
  })

  it('loads the current main migration snapshot emitted by git ls-tree', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'capgo-main-migrations-'))
    const snapshotPath = join(tempDirectory, 'current-main-migrations.txt')
    const previousSnapshotPath = process.env.CURRENT_MAIN_MIGRATION_PATHS_FILE
    await writeFile(snapshotPath, [
      'supabase/migrations/20261001090000_old.sql',
      'supabase/migrations/20261001120000_current.sql',
      '',
    ].join('\0'))
    process.env.CURRENT_MAIN_MIGRATION_PATHS_FILE = snapshotPath

    const pullsList = vi.fn()
    const listFiles = vi.fn()
    const listComments = vi.fn()
    const createComment = vi.fn()
    const github = {
      paginate: vi.fn(async (method) => {
        if (method === pullsList)
          return [{ number: 21, updated_at: '2026-10-01T10:00:00Z' }]
        if (method === listFiles)
          return [{ filename: 'supabase/migrations/20261001100000_stale.sql', status: 'added' }]
        return []
      }),
      rest: {
        issues: { createComment, deleteComment: vi.fn(), listComments, updateComment: vi.fn() },
        pulls: { list: pullsList, listFiles },
      },
    }

    try {
      await warningModule.warnStalePrMigrations({
        github,
        context: {
          payload: { repository: { default_branch: 'main' } },
          repo: { owner: 'Cap-go', repo: 'capgo.app' },
          sha: 'abc123',
        },
        core: { info: vi.fn(), notice: vi.fn(), warning: vi.fn() },
        currentMainMigrationPaths: undefined,
        mainMigrationPaths: ['supabase/migrations/20261001093410_trigger.sql'],
        now: new Date('2026-10-01T12:00:00Z'),
      })

      expect(createComment).toHaveBeenCalledOnce()
      expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining('20261001120000_current.sql'),
      }))
    }
    finally {
      if (previousSnapshotPath === undefined)
        delete process.env.CURRENT_MAIN_MIGRATION_PATHS_FILE
      else
        process.env.CURRENT_MAIN_MIGRATION_PATHS_FILE = previousSnapshotPath
      await rm(tempDirectory, { recursive: true, force: true })
    }
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
    expect(findStep?.run).toContain('git fetch --no-tags origin')
    expect(findStep?.run).toContain('git ls-tree -rz --name-only')
    expect(findStep?.run).toContain('if ! git fetch')
    expect(findStep?.run).toContain('if ! git ls-tree')
    expect(steps.find(step => step.name === 'Warn affected pull requests')?.uses).toBe('actions/github-script@v8')
  })
})
