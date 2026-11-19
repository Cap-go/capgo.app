import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { boundContext, collectReleaseContext } from '../src/bundle/recommend-context'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
test('collects real git changes since a tag without source or authors', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'capgo-recommend-'))
  directories.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd })
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.com')
  git('config', 'user.name', 'Fixture')
  writeFileSync(join(cwd, 'app.txt'), 'private source\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  git('tag', '1.0.0')
  writeFileSync(join(cwd, 'app.txt'), 'private source\nchanged\n')
  git('commit', '-qam', 'fix: correct rendering')
  writeFileSync(join(cwd, 'app.txt'), 'private source\npending\n')
  writeFileSync(join(cwd, '.env'), 'SECRET=never-upload')
  const context = await collectReleaseContext({}, cwd)
  expect(context.commits).toContain('fix: correct rendering')
  expect(context.changes).toContain('app.txt')
  expect(context.tags).toContain('1.0.0')
  expect(JSON.stringify(context)).not.toMatch(/private source|fixture@example|never-upload/)
  expect(context.truncated).toBe(false)
  await expect(collectReleaseContext({ since: '--help' }, cwd)).rejects.toThrow()
})
test('bounds and redacts submitted context', () => {
  const context = boundContext('local', `author@example.com ghp_fakeSecret ${'a'.repeat(16001)}`, '', '')
  expect(context.commits.length).toBe(16000)
  expect(context.commits).not.toContain('author@example.com')
  expect(context.commits).not.toContain('ghp_fakeSecret')
  expect(context.truncated).toBe(true)
})
test('requires explicit bounded GitHub comparison refs', async () => {
  await expect(collectReleaseContext({ repo: 'example/app' })).rejects.toThrow('requires')
})
