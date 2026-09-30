import { describe, expect, it } from 'vitest'
import { getTransientCiJobFailure } from '../scripts/retry-transient-ci-run'

describe('transient CI job retry classifier', () => {
  it('classifies external runner shutdowns as transient', () => {
    expect(getTransientCiJobFailure(
      [
        '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.',
        '##[error]Process completed with exit code 143.',
        'Cleaning up orphan processes',
      ].join('\n'),
      ['Run Supabase Start'],
    )).toBe('runner_shutdown')
  })

  it('ignores shutdown text that is not the terminal runner trailer', () => {
    const output = [
      '##[error]The runner has received a shutdown signal.',
      '##[error]Process completed with exit code 143.',
      'Cleaning up orphan processes',
      'FAIL tests/product.test.ts > product assertion',
    ].join('\n')

    expect(getTransientCiJobFailure(output, ['Run backend integration tests'])).toBeNull()
  })

  it('classifies exhausted Docker startup failures only when Supabase start failed', () => {
    const output = 'SUPABASE_START_FINAL_FAILURE=docker_image_pull'

    expect(getTransientCiJobFailure(output, ['Run Supabase Start'])).toBe('supabase_docker_image_pull')
    expect(getTransientCiJobFailure(output, ['Run backend integration tests'])).toBeNull()
  })

  it('uses the terminal startup classification instead of earlier retry output', () => {
    const output = [
      'failed to pull docker image',
      'request returned 503 Service Unavailable',
      'Migration failed: relation does not exist',
      'SUPABASE_START_FINAL_FAILURE=non_transient',
    ].join('\n')

    expect(getTransientCiJobFailure(output, ['Run Supabase Start'])).toBeNull()
  })

  it('does not classify application failures or generic HTTP 500 responses as transient', () => {
    expect(getTransientCiJobFailure('AssertionError: expected 500 to be 200', ['Run backend integration tests'])).toBeNull()
    expect(getTransientCiJobFailure('Migration failed: relation does not exist', ['Run Supabase Start'])).toBeNull()
  })
})
