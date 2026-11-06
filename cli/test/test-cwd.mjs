import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { withCwd } from '../src/build/cwd.ts'

const originalCwd = process.cwd()
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-cwd-')))
const firstDir = join(fixture, 'first')
const secondDir = join(fixture, 'second')
const childDir = join(firstDir, 'child')
for (const directory of [firstDir, secondDir, childDir])
  mkdirSync(directory, { recursive: true })

try {
  let signalStarted
  let signalRelease
  const started = new Promise(resolve => { signalStarted = resolve })
  const release = new Promise(resolve => { signalRelease = resolve })
  const first = withCwd(firstDir, async () => {
    assert.equal(process.cwd(), firstDir)
    signalStarted()
    await release
    assert.equal(process.cwd(), firstDir)
    return 'first'
  })
  await started
  const second = withCwd(secondDir, async () => {
    assert.equal(process.cwd(), secondDir)
    return 'second'
  })
  signalRelease()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.equal(process.cwd(), originalCwd)

  await withCwd(firstDir, async () => {
    const nested = await Promise.all([
      withCwd('child', async () => {
        await Promise.resolve()
        assert.equal(process.cwd(), childDir)
        return process.cwd()
      }),
      withCwd(secondDir, async () => {
        await Promise.resolve()
        assert.equal(process.cwd(), secondDir)
        return process.cwd()
      }),
    ])
    assert.deepEqual(nested, [childDir, secondDir])
    assert.equal(process.cwd(), firstDir)
    await assert.rejects(withCwd(secondDir, async () => { throw new Error('example nested failure') }), /example nested failure/)
    assert.equal(process.cwd(), firstDir)
    await assert.rejects(withCwd(join(fixture, 'missing'), async () => {}), /Failed to change working directory/)
    assert.equal(await withCwd(childDir, async () => process.cwd()), childDir)
    assert.equal(process.cwd(), firstDir)
  })
  assert.equal(process.cwd(), originalCwd)

  let queuedChild
  await withCwd(firstDir, async () => {
    queuedChild = withCwd(childDir, async () => {
      await Promise.resolve()
      assert.equal(process.cwd(), childDir)
    })
  })
  assert.equal(process.cwd(), originalCwd)
  await queuedChild

  await assert.rejects(withCwd(firstDir, async () => { throw new Error('example failure') }), /example failure/)
  assert.equal(process.cwd(), originalCwd)
  assert.equal(await withCwd(secondDir, async () => process.cwd()), secondDir)

  let releaseLate
  let lateWork
  await withCwd(firstDir, async () => {
    const late = new Promise(resolve => { releaseLate = resolve })
    lateWork = late.then(() => withCwd(secondDir, async () => {
      assert.equal(process.cwd(), secondDir)
    }))
  })
  await withCwd(firstDir, async () => {
    releaseLate()
    await Promise.resolve()
    assert.equal(process.cwd(), firstDir)
  })
  await lateWork
  assert.equal(process.cwd(), originalCwd)
  console.log('✅ Shared CWD scopes: concurrent requests, nested calls, relative paths, restoration, and error recovery')
}
finally {
  process.chdir(originalCwd)
  rmSync(fixture, { recursive: true, force: true })
}
