export function isChannelAlreadyExistsError(error: unknown): boolean {
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

  return errorMessage.includes('unique_name_app_id')
    || (errorMessage.includes('duplicate key') && errorMessage.includes('channel'))
    || errorMessage.includes('23505')
}
