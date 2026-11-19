import { Hono } from 'hono/tiny'
import { describe, expect, it, vi } from 'vitest'
import { buildFunctionsEnvFile, getTransientSupabaseStartFailure } from '../scripts/supabase-worktree'
import { getDatabaseURL } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'

describe('buildFunctionsEnvFile', () => {
  it('uses the isolated API port for storage and public file URLs', () => {
    const generated = buildFunctionsEnvFile([
      'S3_ENDPOINT=127.0.0.1:54321/storage/v1/s3',
      'FILES_PUBLIC_URL=http://kong:8000/functions/v1',
      'MANIFEST_UPLOAD_CAPABILITY_KEY_ID=local-test',
      '',
    ].join('\n'), 56521, 'capgo-app-fixture')

    expect(generated).toContain('S3_ENDPOINT=127.0.0.1:56521/storage/v1/s3\n')
    expect(generated).toContain('FILES_PUBLIC_URL=http://127.0.0.1:56521/functions/v1\n')
    expect(generated).toContain('MANIFEST_UPLOAD_CAPABILITY_KEY_ID=local-test\n')
    expect(generated).not.toContain('kong:8000')
  })

  it('configures an isolated local replica fixture that plugin reads can use without primary fallback', async () => {
    const generated = buildFunctionsEnvFile([
      'ENV_NAME=capgo_api-prod',
      'LOCAL_READ_REPLICA_SUPABASE_DB_URL=postgresql://stale-fixture',
      '',
    ].join('\n'), 56521, 'capgo-app-fixture')
    const env = Object.fromEntries(generated.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    const expected = 'postgresql://postgres:postgres@supabase_db_capgo-app-fixture:5432/postgres'
    const app = new Hono()
    app.get('/', c => c.json({ source: getDatabaseURL(c, true) }))
    try {
      vi.stubEnv('ENV_NAME', env.ENV_NAME)
      vi.stubEnv('LOCAL_READ_REPLICA_SUPABASE_DB_URL', env.LOCAL_READ_REPLICA_SUPABASE_DB_URL)
      const response = await app.request('/', {}, env)
      expect(response.status).toBe(200)
      // The runtime uses Supabase's per-network `db` alias inside Docker.
      expect(await response.json()).toEqual({ source: 'postgresql://postgres:postgres@db:5432/postgres' })
      expect(env.LOCAL_READ_REPLICA_SUPABASE_DB_URL).toBe(expected)
      expect(env.ENV_NAME).toBe('capgo_api-local')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('getTransientSupabaseStartFailure', () => {
  it.each([
    'Bind for 0.0.0.0:54321 failed: address already in use',
    'failed to bind host port for 0.0.0.0:54321',
  ])('classifies Docker port conflict %j as transient', (output) => {
    expect(getTransientSupabaseStartFailure(output)).toBe('docker_port_bind')
  })

  it.each([
    'failed to pull docker image: Error response from daemon: toomanyrequests: Data limit exceeded',
    'failed to pull docker image\nrequest returned 500 Internal Server Error',
    'registry docker.io request failed: TLS handshake timeout',
    'error response from daemon while fetching manifest: unexpected EOF',
    [
      'failed to pull docker image from all registries:',
      'docker.io: unauthorized',
      'public.ecr.aws: manifest unknown',
      'ghcr.io: request returned 503 Service Unavailable',
    ].join('\n'),
  ])('classifies Docker registry failure %j as transient', (output) => {
    expect(getTransientSupabaseStartFailure(output)).toBe('docker_image_pull')
  })

  it('classifies an edge runtime that missed its health check as transient', () => {
    // Trimmed from a GitHub Actions `supabase start` that passed on rerun.
    const output = [
      'Starting containers...',
      'Waiting for health checks...',
      'supabase_edge_runtime_capgo-app-c4051c82 container logs:',
      'Serving functions on http://127.0.0.1:56921/functions/v1/<function-name>',
      'Using supabase-edge-runtime-1.68.4 (compatible with Deno v1.45.2)',
      'Stopping containers...',
      'Error status 503: ',
      'Try rerunning the command with --debug to troubleshoot the error.',
    ].join('\n')
    expect(getTransientSupabaseStartFailure(output)).toBe('edge_runtime_health_check')
    // A 503 without the health-check wait is not this failure.
    expect(getTransientSupabaseStartFailure('Error status 503: ')).toBeNull()
  })

  it.each([
    'POST /private/example returned 500 Internal Server Error',
    'Error response from daemon: 500 container create failed',
    'Migration failed: relation "public.example" does not exist',
    'Test assertion failed: expected 200, received 500',
  ])('does not retry deterministic failure %j', (output) => {
    expect(getTransientSupabaseStartFailure(output)).toBeNull()
  })
})
