import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('rn-cli export layout contract', () => {
  test('expected Capgo delta folder shape', () => {
    const dir = join(tmpdir(), `capgo-rn-export-${Date.now()}`)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.android.bundle'), 'android')
    writeFileSync(join(dir, 'main.jsbundle'), 'ios')
    writeFileSync(join(dir, 'assets', 'img.png'), 'x')

    expect(existsSync(join(dir, 'index.android.bundle'))).toBe(true)
    expect(existsSync(join(dir, 'main.jsbundle'))).toBe(true)
    expect(existsSync(join(dir, 'assets', 'img.png'))).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})
