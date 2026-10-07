import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { deployPluginEu } from '../scripts/deploy-plugin-eu.ts'

describe('production plugin deployment', () => {
  it('deploys each newly uploaded Version ID at 100% across retries', () => {
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
    const outputs: string[] = []
    const run = vi.fn((args: string[], env: NodeJS.ProcessEnv) => {
      if (args[1] === 'upload') {
        outputs.push(env.WRANGLER_OUTPUT_FILE_PATH!)
        writeFileSync(env.WRANGLER_OUTPUT_FILE_PATH!, `${JSON.stringify({ type: 'wrangler-session' })}\n${JSON.stringify({ type: 'version-upload', worker_name: 'capgo_plugin-eu-prod', version_id: ids.shift() })}\n`)
      }
    })
    deployPluginEu(run)
    deployPluginEu(run)
    expect(run.mock.calls.filter(([args]) => args[1] === 'deploy').map(([args]) => args[2])).toEqual([
      '11111111-1111-1111-1111-111111111111@100',
      '22222222-2222-2222-2222-222222222222@100',
    ])
    expect(outputs.every(path => !existsSync(path))).toBe(true)
  })

  it('does not deploy after an upload failure', () => {
    const run = vi.fn(() => {
      throw new Error('upload failed')
    })
    expect(() => deployPluginEu(run)).toThrow('upload failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to an older version when the upload returns no ID', () => {
    const run = vi.fn((_args: string[], env: NodeJS.ProcessEnv) => {
      writeFileSync(env.WRANGLER_OUTPUT_FILE_PATH!, JSON.stringify({ type: 'version-upload', worker_name: 'capgo_plugin-eu-prod', version_id: null }))
    })
    expect(() => deployPluginEu(run)).toThrow('refusing to deploy another version')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
