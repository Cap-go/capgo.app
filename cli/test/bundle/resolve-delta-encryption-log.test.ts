import type { UploadReporter } from '../../src/bundle/reporter'
import type { OptionsUpload } from '../../src/bundle/upload_interface'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { resolveDeltaEncryptionSettings } from '../../src/bundle/upload-artifact'
import { runWithUploadReporter } from '../../src/bundle/reporter'

function recordingReporter(infoMessages: string[]): UploadReporter {
  return {
    info: message => infoMessages.push(message),
    warn: () => {},
    error: () => {},
    success: () => {},
    intro: () => {},
    outro: () => {},
    spinner: () => ({
      start: () => {},
      message: () => {},
      stop: () => {},
      error: () => {},
    }),
  }
}

describe('resolveDeltaEncryptionSettings logging', () => {
  const originalCwd = cwd()
  let projectDir = ''
  const infoMessages: string[] = []

  beforeEach(() => {
    infoMessages.length = 0
    projectDir = mkdtempSync(join(tmpdir(), 'capgo-delta-log-'))
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      name: 'delta-log-fixture',
      version: '1.0.0',
      dependencies: {
        '@capgo/capacitor-updater': '^8.51.14',
      },
    }))
    const updaterDir = join(projectDir, 'node_modules', '@capgo', 'capacitor-updater')
    mkdirSync(updaterDir, { recursive: true })
    writeFileSync(join(updaterDir, 'package.json'), JSON.stringify({
      name: '@capgo/capacitor-updater',
      version: '8.51.14',
    }))
    process.chdir(projectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('logs the installed updater version string, not a parsed SemVer object', async () => {
    const options: OptionsUpload = {
      delta: true,
      encryptDelta: false,
      verbose: true,
    } as OptionsUpload

    await runWithUploadReporter(recordingReporter(infoMessages), async () => {
      await resolveDeltaEncryptionSettings(options, 'v2')
    })

    const autoEnableLine = infoMessages.find(message =>
      message.includes('Auto-enabling delta update encryption for updater version'),
    )
    expect(autoEnableLine).toBeDefined()
    expect(autoEnableLine).toContain('8.51.14')
    expect(autoEnableLine).not.toContain('[object Object]')

    const verboseHexLine = infoMessages.find(message =>
      message.includes('[Verbose] Using hex checksum format for updater version'),
    )
    expect(verboseHexLine).toBeDefined()
    expect(verboseHexLine).toContain('8.51.14')
    expect(verboseHexLine).not.toContain('[object Object]')

    expect(options.encryptDelta).toBe(true)
  })
})
