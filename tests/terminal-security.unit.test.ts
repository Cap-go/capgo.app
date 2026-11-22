import { describe, expect, it } from 'vitest'
import { TERMINAL_EGRESS_ALLOWLIST } from '../cloudflare_workers/terminal/lib/constants.ts'
import { isEgressHostAllowed } from '../cloudflare_workers/terminal/lib/egress.ts'
import {
  extractApiKey,
  parseSessionRoute,
} from '../cloudflare_workers/terminal/lib/http.ts'
import {
  assertSafeCommand,
  buildSessionKey,
  capOutputBytes,
  resolveWorkspacePath,
  sessionAlarmAtMs,
  shouldTeardownByAlarm,
} from '../cloudflare_workers/terminal/lib/security.ts'

describe('terminal security', () => {
  it('builds stable session keys', () => {
    expect(buildSessionKey('org', 'com.app', 'sess'))
      .toBe('org:com.app:sess')
  })

  it('denies privileged commands', () => {
    expect(() => assertSafeCommand('sudo rm -rf /')).toThrow('command_denied')
    expect(() => assertSafeCommand('echo ok')).not.toThrow()
  })

  it('locks paths to workspace', () => {
    expect(resolveWorkspacePath('src/main.ts')).toBe('/workspace/project/src/main.ts')
    expect(() => resolveWorkspacePath('../etc/passwd')).toThrow('path_outside_workspace')
  })

  it('caps streamed output', () => {
    const first = capOutputBytes('abcdef', 0)
    expect(first.total).toBe(6)
    const limit = 256 * 1024
    const second = capOutputBytes('g'.repeat(limit), first.total)
    expect(second.truncated).toBe(true)
    expect(second.total).toBe(limit)
    expect(new TextEncoder().encode(second.text).length).toBe(limit - first.total)
  })

  it('fires alarm teardown at max duration', () => {
    const started = 1_000
    const alarmAt = sessionAlarmAtMs(started, 60)
    expect(alarmAt).toBe(3_601_000)
    expect(shouldTeardownByAlarm(alarmAt, alarmAt)).toBe(true)
    expect(shouldTeardownByAlarm(alarmAt - 1, alarmAt)).toBe(false)
  })

  it('parses api keys from authorization header', () => {
    const bearer = new Request('https://api.capgo.app/terminal/health', {
      headers: { authorization: 'Bearer capg_test_key' },
    })
  expect(extractApiKey(bearer)).toBe('capg_test_key')
    const emptyBearer = new Request('https://api.capgo.app/terminal/health', {
      headers: { authorization: 'Bearer', capgkey: 'from_header' },
    })
    expect(extractApiKey(emptyBearer)).toBe('from_header')
  })

  it('rejects websocket paths with extra segments', () => {
    const key = 'org:com.app:session'
    expect(parseSessionRoute(`/terminal/ws/${encodeURIComponent(key)}`, '/terminal/ws/')).toBe(key)
    expect(parseSessionRoute(`/terminal/ws/${encodeURIComponent(key)}/extra`, '/terminal/ws/')).toBeNull()
  })

  it('allows only configured egress hosts', () => {
    for (const host of TERMINAL_EGRESS_ALLOWLIST)
      expect(isEgressHostAllowed(host)).toBe(true)
    expect(isEgressHostAllowed('evil.example')).toBe(false)
  })
})