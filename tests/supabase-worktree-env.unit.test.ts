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

    expect(generated).toContain('S3_ENDPOINT=127.0.0.1:56521/storage/v1/s3\n')
    expect(generated).toContain('FILES_PUBLIC_URL=http://127.0.0.1:56521/functions/v1\n')
    expect(generated).toContain('MANIFEST_UPLOAD_CAPABILITY_KEY_ID=local-test\n')
    expect(generated).not.toContain('kong:8000')
  })
})
