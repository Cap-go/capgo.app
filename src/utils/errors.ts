/**
 * Shared error helpers for narrowing `unknown` catch values.
 * Prefer these over `catch (error: any)`.
 */

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

export function getErrorCode(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const candidate = (value as { code?: unknown }).code
    if (typeof candidate === 'string')
      return candidate
  }
  return undefined
}
