import { TERMINAL_OUTPUT_MAX_BYTES, TERMINAL_WORKSPACE_ROOT } from './constants.ts'

const COMMAND_DENY_RE = /\b(sudo|su|mount|umount|chroot|nsenter|pkexec|doas|runuser)\b/i

export function buildSessionKey(orgId: string, appId: string, sessionId: string): string {
  return `${orgId}:${appId}:${sessionId}`
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
  if (!normalized || normalized.includes('..') || normalized.includes('\0'))
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
  const slice = next.slice(0, room)
  return { text: new TextDecoder().decode(slice), total: bytesSoFar + slice.length, truncated: true }
}

export function sessionAlarmAtMs(startedAtMs: number, maxDurationMinutes: number): number {
  return startedAtMs + maxDurationMinutes * 60 * 1000
}

export function shouldTeardownByAlarm(nowMs: number, alarmAtMs: number | null): boolean {
  if (alarmAtMs == null)
    return false
  return nowMs >= alarmAtMs
}