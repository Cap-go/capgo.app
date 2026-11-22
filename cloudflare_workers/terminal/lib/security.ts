import { TERMINAL_OUTPUT_MAX_BYTES, TERMINAL_WORKSPACE_ROOT } from './constants.ts'
import { sha256Hex } from './crypto.ts'

const COMMAND_DENY_RE = /\b(sudo|su|mount|umount|chroot|nsenter|pkexec|doas|runuser)\b/i

export function buildSessionKey(orgId: string, appId: string, sessionId: string): string {
  return `${orgId}:${appId}:${sessionId}`
}

export type TerminalMcpTransport = 'sse' | 'streamable-http' | 'rpc'

/** McpAgent requires `transport:sessionId`; one name for WS + MCP on the same session. */
export async function terminalSessionIdHash(sessionKey: string): Promise<string> {
  return sha256Hex(sessionKey)
}

export async function terminalDurableObjectName(
  sessionKey: string,
  transport: TerminalMcpTransport = 'streamable-http',
): Promise<string> {
  const hash = await terminalSessionIdHash(sessionKey)
  return `${transport}:${hash}`
}

export async function terminalMcpSessionHeaderId(sessionKey: string): Promise<string> {
  return terminalSessionIdHash(sessionKey)
}

function utf8BytePrefix(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length <= maxBytes)
    return bytes
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xC0) === 0x80)
    end--
  return bytes.slice(0, end)
}

export function assertSafeCommand(command: string): void {
  const trimmed = command.trim()
  if (!trimmed)
    throw new Error('empty_command')
  if (COMMAND_DENY_RE.test(trimmed))
    throw new Error('command_denied')
}

export function resolveWorkspacePath(relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, '').trim()
  if (!normalized || normalized.includes('\0'))
    throw new Error('path_outside_workspace')
  if (normalized.split('/').some(segment => segment === '..'))
    throw new Error('path_outside_workspace')
  return `${TERMINAL_WORKSPACE_ROOT}/${normalized}`
}

export function capOutputBytes(chunk: string, bytesSoFar: number): { text: string, total: number, truncated: boolean } {
  const encoder = new TextEncoder()
  const next = encoder.encode(chunk)
  const room = TERMINAL_OUTPUT_MAX_BYTES - bytesSoFar
  if (room <= 0)
    return { text: '', total: bytesSoFar, truncated: true }
  if (next.length <= room)
    return { text: chunk, total: bytesSoFar + next.length, truncated: false }
  const slice = utf8BytePrefix(next, room)
  const text = new TextDecoder().decode(slice)
  const encoded = encoder.encode(text)
  return {
    text,
    total: bytesSoFar + encoded.length,
    truncated: encoded.length < next.length,
  }
}

export async function readTextWithByteCap(response: Response): Promise<{ text: string, truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader)
    return { text: '', truncated: false }
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      const capped = capOutputBytes(decoder.decode(value, { stream: true }), bytes)
      bytes = capped.total
      truncated = truncated || capped.truncated
      text += capped.text
      if (truncated)
        break
    }
    const flush = decoder.decode()
    if (flush) {
      const capped = capOutputBytes(flush, bytes)
      bytes = capped.total
      truncated = truncated || capped.truncated
      text += capped.text
    }
  }
  finally {
    reader.releaseLock()
  }
  return { text, truncated }
}

export function sessionAlarmAtMs(startedAtMs: number, maxDurationMinutes: number): number {
  return startedAtMs + maxDurationMinutes * 60 * 1000
}

export function shouldTeardownByAlarm(nowMs: number, alarmAtMs: number | null): boolean {
  if (alarmAtMs == null)
    return false
  return nowMs >= alarmAtMs
}

export function nextSessionAlarmAtMs(
  startedAtMs: number,
  maxDurationMinutes: number,
  idleMs: number,
  nowMs: number,
): number {
  const maxAt = sessionAlarmAtMs(startedAtMs, maxDurationMinutes)
  const idleAt = nowMs + idleMs
  return Math.min(maxAt, idleAt)
}

export function teardownReasonAtAlarm(
  startedAtMs: number,
  maxDurationMinutes: number,
  nowMs: number,
): 'max_duration_alarm' | 'idle_timeout' {
  const maxAt = sessionAlarmAtMs(startedAtMs, maxDurationMinutes)
  return nowMs >= maxAt ? 'max_duration_alarm' : 'idle_timeout'
}