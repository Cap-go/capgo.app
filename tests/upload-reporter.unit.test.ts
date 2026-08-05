import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../cli/src/utils/latest-version', () => ({
  getLatestVersion: vi.fn(async () => '99.0.0'),
}))

describe('bundle upload reporting', () => {
  it('reports CLI update warnings through the supplied reporter', async () => {
    const warnings: string[] = []
    const { checkAlerts } = await import('../cli/src/api/update')

    await checkAlerts({
      warn(message) {
        warnings.push(message)
      },
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('99.0.0')
  })

  it('routes manifest warnings through the active upload reporter', async () => {
    const infos: string[] = []
    const { runWithUploadReporter } = await import('../cli/src/bundle/reporter')
    const { generateManifest } = await import('../cli/src/utils')
    const directory = mkdtempSync(join(tmpdir(), 'capgo-upload-reporter-'))
    writeFileSync(join(directory, '.DS_Store'), 'ignored')

    await runWithUploadReporter({
      error() {},
      info: message => infos.push(message),
      intro() {},
      outro() {},
      spinner: () => ({ error() {}, message() {}, start() {}, stop() {} }),
      success() {},
      warn() {},
    }, () => generateManifest(directory))

    expect(infos).toHaveLength(1)
    expect(infos[0]).toContain('Ignoring file')
  })

  it('does not treat the normal Clack reporter as an internal-output capture', async () => {
    const { clackUploadReporter, getActiveUploadReporter, getUploadReporter, runWithUploadReporter } = await import('../cli/src/bundle/reporter')

    expect(getUploadReporter()).toBe(clackUploadReporter)

    await runWithUploadReporter(clackUploadReporter, async () => {
      expect(getActiveUploadReporter()).toBeUndefined()
    })
  })

  it('keeps the late permission check silent for internal uploads', async () => {
    const source = readFileSync(new URL('../cli/src/bundle/upload.ts', import.meta.url), 'utf8')

    expect(source).toContain("checkAppExistsAndHasPermissionOrgErr(supabase, apikey, appid, 'app.upload_bundle', silent, true)")
  })
})
