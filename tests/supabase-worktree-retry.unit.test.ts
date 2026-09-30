import { describe, expect, it } from 'vitest'
import { getTransientSupabaseStartFailure } from '../scripts/supabase-worktree'

describe('getTransientSupabaseStartFailure', () => {
  it('classifies Docker port conflicts as transient', () => {
    expect(getTransientSupabaseStartFailure('Bind for 0.0.0.0:54321 failed: address already in use')).toBe('docker_port_bind')
    expect(getTransientSupabaseStartFailure('failed to bind host port for 0.0.0.0:54321')).toBe('docker_port_bind')
  })

  it('classifies Docker registry throttling as transient', () => {
    const output = 'failed to pull docker image: Error response from daemon: toomanyrequests: Data limit exceeded'

    expect(getTransientSupabaseStartFailure(output)).toBe('docker_image_pull')
  })

  it('classifies Docker registry network and 5xx failures as transient', () => {
    expect(getTransientSupabaseStartFailure('failed to pull docker image\nrequest returned 500 Internal Server Error')).toBe('docker_image_pull')
    expect(getTransientSupabaseStartFailure('registry docker.io request failed: TLS handshake timeout')).toBe('docker_image_pull')
    expect(getTransientSupabaseStartFailure('error response from daemon while fetching manifest: unexpected EOF')).toBe('docker_image_pull')
  })

  it('does not retry generic application or deterministic startup failures', () => {
    expect(getTransientSupabaseStartFailure('POST /private/example returned 500 Internal Server Error')).toBeNull()
    expect(getTransientSupabaseStartFailure('Error response from daemon: 500 container create failed')).toBeNull()
    expect(getTransientSupabaseStartFailure('Migration failed: relation "public.example" does not exist')).toBeNull()
    expect(getTransientSupabaseStartFailure('Test assertion failed: expected 200, received 500')).toBeNull()
  })
})
