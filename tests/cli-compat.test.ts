import { execFile } from 'node:child_process'
import { env } from 'node:process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MIN_CLI_VERSION, MIN_CLI_VERSION_REASON } from '../supabase/functions/_backend/utils/cliMinVersion.ts'
import { APIKEY_TEST_ALL, getEndpointUrl } from './test-utils'

const execFileAsync = promisify(execFile)

describe('cLI min-version compatibility', () => {
  it('publishes the pinned min CLI version and reason on /private/config', async () => {
    const response = await fetch(getEndpointUrl('/private/config'))
    expect(response.status).toBe(200)
    const body = await response.json() as {
      minCliVersion?: string
      minCliVersionReason?: string
    }
    expect(body.minCliVersion).toBe(MIN_CLI_VERSION)
    expect(body.minCliVersionReason).toBe(MIN_CLI_VERSION_REASON)
  })

  it('runs the pinned min CLI against the current API', async () => {
    const { stdout: versionOut } = await execFileAsync('bunx', [`@capgo/cli@${MIN_CLI_VERSION}`, '--version'], {
      timeout: 120000,
    })
    expect(versionOut.trim()).toBe(MIN_CLI_VERSION)

    await execFileAsync('bunx', [
      `@capgo/cli@${MIN_CLI_VERSION}`,
      'app',
      'list',
      '--output-text',
      '-a',
      APIKEY_TEST_ALL,
      '--supa-host',
      env.SUPABASE_URL || 'http://127.0.0.1:54321',
      '--supa-anon',
      env.SUPABASE_ANON_KEY || '',
    ], {
      timeout: 120000,
    })
  }, 180000)
})
