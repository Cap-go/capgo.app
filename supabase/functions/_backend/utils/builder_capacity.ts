export function msFromBuilderTimestamp(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return null
  return Math.trunc(value)
}

export function isoFromBuilderTimestamp(value: number | null | undefined): string | null {
  const ms = msFromBuilderTimestamp(value)
  if (ms === null)
    return null
  return new Date(ms).toISOString()
}
