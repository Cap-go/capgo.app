import { describe, expect, it } from 'vitest'
import { assertTerminalApiKeyPolicy } from '../cloudflare_workers/terminal/lib/apikey.ts'
import { TERMINAL_EGRESS_ALLOWLIST, TERMINAL_IDLE_MS, TERMINAL_MAX_SESSION_MINUTES } from '../cloudflare_workers/terminal/lib/constants.ts'
import { isEgressHostAllowed } from '../cloudflare_workers/terminal/lib/egress.ts'
import { handleTerminalEgress } from '../cloudflare_workers/terminal/lib/egress_proxy.ts'
import {
  extractApiKey,
  normalizeTerminalPath,
  parseSessionRoute,
} from '../cloudflare_workers/terminal/lib/http.ts'
import {
  assertSafeCommand,
  buildSessionKey,
  capOutputBytes,
  nextSessionAlarmAtMs,
  resolveWorkspacePath,
  sessionAlarmAtMs,
  shouldTeardownByAlarm,
  teardownReasonAtAlarm,
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

  it('resets the output cap for each command', () => {
    const limit = 256 * 1024
    const first = capOutputBytes('a'.repeat(limit), 0)
    expect(first.truncated).toBe(false)
    const second = capOutputBytes('bb', 0)
    expect(second.total).toBe(2)
    expect(second.truncated).toBe(false)
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

  it('blocks egress proxy traffic outside the allowlist', async () => {
    const denied = await handleTerminalEgress(new Request('https://evil.example/path'))
    expect(denied.status).toBe(403)
  })

  it('normalizes terminal paths with a trailing slash', () => {
    expect(normalizeTerminalPath('/terminal/sessions/')).toBe('/terminal/sessions')
    expect(normalizeTerminalPath('/terminal/health')).toBe('/terminal/health')
  })

  it('schedules idle teardown before max duration', () => {
    const started = 10_000
    const now = started + 1_000
    const alarmAt = nextSessionAlarmAtMs(started, TERMINAL_MAX_SESSION_MINUTES, TERMINAL_IDLE_MS, now)
    expect(alarmAt).toBe(now + TERMINAL_IDLE_MS)
    expect(teardownReasonAtAlarm(started, TERMINAL_MAX_SESSION_MINUTES, alarmAt)).toBe('idle_timeout')
  })

  it('requires write or all on an app-scoped key', () => {
    expect(() => assertTerminalApiKeyPolicy(true, true)).not.toThrow()
    expect(() => assertTerminalApiKeyPolicy(false, true)).toThrow('apikey_app_forbidden')
    expect(() => assertTerminalApiKeyPolicy(true, false)).toThrow('apikey_not_app_scoped')
  })
})