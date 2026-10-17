import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { buildFunctionsEnvFile } from '../scripts/supabase-worktree'

describe('buildFunctionsEnvFile', () => {
  it('uses the isolated API port for storage and public file URLs', () => {
    const generated = buildFunctionsEnvFile([
      'S3_ENDPOINT=127.0.0.1:54321/storage/v1/s3',
      'FILES_PUBLIC_URL=http://kong:8000/functions/v1',
      'MANIFEST_UPLOAD_CAPABILITY_KEY_ID=local-test',
      '',
    ].join('\n'), 56521)

    const env = parse(generated)
    expect(env.S3_ENDPOINT).toBe('127.0.0.1:56521/storage/v1/s3')
    expect(env.FILES_PUBLIC_URL).toBe('http://127.0.0.1:56521/functions/v1')
    expect(env.MANIFEST_UPLOAD_CAPABILITY_KEY_ID).toBe('local-test')
  })
})
