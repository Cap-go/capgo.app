import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const disabledArtifact = 'export const servingRegionReaderEpoch = null\n'

function prepare(value: string, name = 'CAPGO_SERVING_REGIONS_READER_EPOCH') {
  const directory = mkdtempSync(join(tmpdir(), 'capgo-serving-epoch-'))
  try {
    const script = join(directory, 'scripts/prepare-serving-region-rollout.ts')
    const target = join(directory, 'supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js')
    const input = join(directory, 'reader-setting.json')
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    mkdirSync(join(directory, 'supabase/functions/_backend/plugin_runtime/utils'), { recursive: true })
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
    copyFileSync(new URL('../scripts/prepare-serving-region-rollout.ts', import.meta.url), script)
    writeFileSync(target, disabledArtifact)
    writeFileSync(input, JSON.stringify([{ name, value }]))
    const result = spawnSync('bun', [script, input], { cwd: directory, encoding: 'utf8' })
    return { status: result.status, stderr: result.stderr, artifact: readFileSync(target, 'utf8') }
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('offline serving-region reader epoch preparation', () => {
  it.concurrent.each([
    'release1',
    'release-20261116',
    'release_20261116',
    'RELEASE-20261116',
    '_A-b_123',
    'a'.repeat(65),
    'Release_'.repeat(10),
  ])('prepares the database-supported epoch %s without touching the checkout artifact', (value) => {
    const result = prepare(value)
    expect(result.status, result.stderr).toBe(0)
    expect(result.artifact).toContain('export const servingRegionReaderEpoch = ' + JSON.stringify(value))
  })

  it.concurrent.each(['short12', 'a'.repeat(81), 'release.with.dot', 'release space', 'release\n2026'])('rejects unsupported epoch %s before changing the artifact', (value) => {
    const result = prepare(value)
    expect(result.status).not.toBe(0)
    expect(result.artifact).toBe(disabledArtifact)
  })

  it.concurrent('preserves the explicit disabled preparation', () => {
    const result = prepare('')
    expect(result.status, result.stderr).toBe(0)
    expect(result.artifact).toContain('export const servingRegionReaderEpoch = null')
  })

  it.concurrent('rejects unrelated settings exports before changing the artifact', () => {
    const result = prepare('fixture-not-a-secret', 'UNRELATED_SETTING')
    expect(result.status).not.toBe(0)
    expect(result.artifact).toBe(disabledArtifact)
  })
})
