import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { getTransientSupabaseStartFailure, upsertEnvValue } from '../scripts/supabase-worktree'

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
    expect(getTransientSupabaseStartFailure([
      'failed to pull docker image from all registries:',
      'docker.io: unauthorized',
      'public.ecr.aws: manifest unknown',
      'ghcr.io: request returned 503 Service Unavailable',
    ].join('\n'))).toBe('docker_image_pull')
  })

  it('does not retry generic application or deterministic startup failures', () => {
    expect(getTransientSupabaseStartFailure('POST /private/example returned 500 Internal Server Error')).toBeNull()
    expect(getTransientSupabaseStartFailure('Error response from daemon: 500 container create failed')).toBeNull()
    expect(getTransientSupabaseStartFailure('Migration failed: relation "public.example" does not exist')).toBeNull()
    expect(getTransientSupabaseStartFailure('Test assertion failed: expected 200, received 500')).toBeNull()
  })
})

describe('generated environment values', () => {
  it.each([
    '$&-$$-$` private#secret',
    'smtp://user:pass#word@example.com:1025',
    ' spaced secret ',
    'line one\nline two',
    'literal\\n-value',
    'quote`and\'value',
  ])('preserves special characters through dotenv parsing: %s', (value) => {
    const generated = upsertEnvValue('OTHER=untouched\nBETTER_AUTH_SECRET="old\nmultiline"\n', 'BETTER_AUTH_SECRET', value)
    expect(parse(generated)).toEqual({ OTHER: 'untouched', BETTER_AUTH_SECRET: value })
  })

  it('preserves an already configured quoted value', () => {
    const source = 'BETTER_AUTH_SECRET="configured#secret" # comment\n'
    expect(parse(upsertEnvValue(source, 'BETTER_AUTH_SECRET', 'configured#secret')).BETTER_AUTH_SECRET).toBe('configured#secret')
  })
})

it('rejects a value that cannot be represented literally in both env parsers', () => {
  expect(() => upsertEnvValue('', 'BETTER_AUTH_SECRET', 'apostrophe\'and$dollar')).toThrow('Cannot serialize environment variable BETTER_AUTH_SECRET')
})

it.each(['fake-$MISSING-secret', 'fake\\q-secret'])('uses literal single quoting for Supabase-sensitive value %s', (value) => {
  const generated = upsertEnvValue('BETTER_AUTH_SECRET=old\n', 'BETTER_AUTH_SECRET', value)
  expect(generated).toContain(`BETTER_AUTH_SECRET='${value}'`)
  expect(parse(generated).BETTER_AUTH_SECRET).toBe(value)
})
