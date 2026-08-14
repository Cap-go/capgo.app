export type ChannelUpdatePackageErrorKey
  = 'update-package-zip-required'
    | 'update-package-delta-required'

function readErrorText(error: unknown): string {
  if (!error)
    return ''
  if (typeof error === 'string')
    return error
  if (typeof error === 'object') {
    const record = error as { message?: unknown, details?: unknown, hint?: unknown }
    return [record.message, record.details, record.hint]
      .filter(value => typeof value === 'string' && value.length > 0)
      .join('\n')
  }
  return String(error)
}

export function channelUpdatePackageErrorKey(error: unknown): ChannelUpdatePackageErrorKey | null {
  const message = readErrorText(error)
  if (message.includes('CHANNEL_ZIP_REQUIRED'))
    return 'update-package-zip-required'
  if (message.includes('CHANNEL_DELTA_REQUIRED'))
    return 'update-package-delta-required'
  return null
}
