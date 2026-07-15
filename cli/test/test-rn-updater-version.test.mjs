import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Dynamic import after build; for source we import ts via bun
const { getCapgoUpdaterPackageVersion } = await import('../src/utils.ts')

describe('getCapgoUpdaterPackageVersion', () => {
  test('detects react-native updater package', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capgo-rn-'))
    try {
      mkdirSync(join(dir, 'node_modules', '@capgo', 'react-native-updater'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@capgo/react-native-updater': '0.1.0' } }))
      writeFileSync(
        join(dir, 'node_modules', '@capgo', 'react-native-updater', 'package.json'),
        JSON.stringify({ name: '@capgo/react-native-updater', version: '0.1.0' }),
      )
      const result = await getCapgoUpdaterPackageVersion(dir)
      expect(result?.kind).toBe('react-native')
      expect(result?.version).toBe('0.1.0')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
