import { randomBytes } from 'node:crypto'

export function isAppAlreadyExistsError(error: unknown): boolean {
  const errorMessage = (() => {
    if (error instanceof Error)
      return error.message
    if (error && typeof error === 'object') {
      const candidate = error as {
        message?: unknown
        details?: unknown
        hint?: unknown
        code?: unknown
      }
      return [candidate.message, candidate.details, candidate.hint, candidate.code]
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        .join(' ')
    }
    return String(error)
  })().toLowerCase()
  return errorMessage.includes('already exist')
    || errorMessage.includes('duplicate key')
    || errorMessage.includes('23505')
}

function secureRandomFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000
}

export function buildAppIdConflictSuggestions(
  baseAppId: string,
  random = secureRandomFraction,
  now = Date.now,
): string[] {
  const randomSuffix = random().toString(36).substring(2, 6) || 'dev'
  return [
    `${baseAppId}-${randomSuffix}`,
    `${baseAppId}.dev`,
    `${baseAppId}.app`,
    `${baseAppId}-${now().toString().slice(-4)}`,
    `${baseAppId}2`,
    `${baseAppId}3`,
  ]
}
