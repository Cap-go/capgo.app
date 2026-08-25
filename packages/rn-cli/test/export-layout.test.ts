import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateExportLayout } from '../src/bundle.js'

describe('rn-cli export layout contract', () => {
  test('validateExportLayout accepts Capgo delta folder shape', () => {
    const dir = join(tmpdir(), `capgo-rn-export-${Date.now()}`)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.android.bundle'), 'android')
    writeFileSync(join(dir, 'main.jsbundle'), 'ios')
    writeFileSync(join(dir, 'assets', 'img.png'), 'x')

    validateExportLayout(dir)

    rmSync(dir, { recursive: true, force: true })
  })

  test('validateExportLayout rejects incomplete exports', () => {
    const dir = join(tmpdir(), `capgo-rn-export-missing-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.android.bundle'), 'android')

    expect(() => validateExportLayout(dir)).toThrow('Missing required export file: main.jsbundle')

    rmSync(dir, { recursive: true, force: true })
  })
})
