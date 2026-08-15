import { simpleError } from './hono.ts'

const ZIP_REQUIRED = 'CHANNEL_ZIP_REQUIRED'
const DELTA_REQUIRED = 'CHANNEL_DELTA_REQUIRED'

function readErrorText(error: unknown): string {
  if (!error)
    return ''
  if (typeof error === 'string')
    return error
  if (error instanceof Error) {
    const extras = [
      error.message,
      (error as { code?: unknown }).code,
      (error as { details?: unknown }).details,
      (error as { cause?: { message?: unknown } }).cause?.message,
    ].filter(value => typeof value === 'string')
    return extras.join('\n')
  }
  if (typeof error === 'object' && 'message' in error)
    return String((error as { message?: unknown }).message ?? '')
  return String(error)
}

function messageAfterPrefix(text: string, prefix: string): string {
  const index = text.indexOf(prefix)
  if (index < 0)
    return text
  return text.slice(index + prefix.length).replace(/^:\s*/, '').split('\n')[0]!.trim()
}

export function throwIfChannelUpdatePackageMismatch(error: unknown): void {
  const text = readErrorText(error)
  if (text.includes(ZIP_REQUIRED)) {
    throw simpleError(
      'channel_zip_required',
      messageAfterPrefix(text, ZIP_REQUIRED) || 'This channel requires a zip package, but the bundle has no zip.',
    )
  }
  if (text.includes(DELTA_REQUIRED)) {
    throw simpleError(
      'channel_delta_required',
      messageAfterPrefix(text, DELTA_REQUIRED) || 'This channel requires a delta package, but the bundle has no delta files.',
    )
  }
}
