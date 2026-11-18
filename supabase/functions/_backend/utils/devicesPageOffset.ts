/**
 * Largest number of rows a device page request may skip after its cursor.
 * The console chains jumps past this bound, so each query stays bounded.
 * Kept free of imports: the device readers in cloudflare.ts and supabase.ts use it.
 */
export const MAX_DEVICES_PAGE_OFFSET = 100_000

/** `OFFSET n` clause for a validated device page offset, or '' when none applies. */
export function devicesOffsetClause(offset: number | undefined): string {
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset <= 0)
    return ''
  return `OFFSET ${Math.min(offset, MAX_DEVICES_PAGE_OFFSET)}`
}
