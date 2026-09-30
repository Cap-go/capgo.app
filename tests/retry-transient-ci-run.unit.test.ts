import { describe, expect, it } from 'vitest'
import { getTransientCiJobFailure } from '../scripts/retry-transient-ci-run'

describe('transient CI job retry classifier', () => {
  it('classifies external runner shutdowns as transient', () => {
    expect(getTransientCiJobFailure(
      'The runner has received a shutdown signal. This can happen when the runner service is stopped.',
      ['Run Supabase Start'],
    )).toBe('runner_shutdown')
  })

  it('classifies exhausted Docker startup failures only when Supabase start failed', () => {
    const output = 'failed to pull docker image\nrequest returned 503 Service Unavailable'

    expect(getTransientCiJobFailure(output, ['Run Supabase Start'])).toBe('supabase_docker_image_pull')
    expect(getTransientCiJobFailure(output, ['Run backend integration tests'])).toBeNull()
  })

  it('does not classify application failures or generic HTTP 500 responses as transient', () => {
    expect(getTransientCiJobFailure('AssertionError: expected 500 to be 200', ['Run backend integration tests'])).toBeNull()
    expect(getTransientCiJobFailure('Migration failed: relation does not exist', ['Run Supabase Start'])).toBeNull()
  })
})
