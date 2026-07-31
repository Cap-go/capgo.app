/**
 * Shared error helpers for narrowing `unknown` catch values.
 * Prefer these over `catch (error: any)`.
 */

export type UnknownRecord = Record<string, unknown>

export function getErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value

  if (value instanceof Error)
    return value.message

  if (typeof value === 'object' && value !== null) {
    const candidate = (value as { message?: unknown }).message
    if (typeof candidate === 'string')
      return candidate
  }

  return undefined
}

export function errorMessage(value: unknown, fallback: string): string {
  return getErrorMessage(value) ?? fallback
}

export function getErrorStatus(value: unknown): number | undefined {
  if (typeof value === 'object' && value !== null) {
    const candidate = (value as { status?: unknown }).status
    if (typeof candidate === 'number')
      return candidate
  }
  return undefined
}

export function getErrorCode(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const candidate = (value as { code?: unknown }).code
    if (typeof candidate === 'string')
      return candidate
  }
  return undefined
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
