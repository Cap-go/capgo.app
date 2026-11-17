// Storage is billed in GB-hours: the bytes each bundle stays stored, times the hours it stays.
// A plan with S GB of storage includes S x hours-in-cycle GB-hours, which is the same as
// comparing the average stored over the cycle (byte-hours / hours) with S GB.

const HOUR_MS = 60 * 60 * 1000

/** Hours between two instants, at least one so a partial range never divides by zero. */
export function hoursInRange(start: string | Date, end: string | Date): number {
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / HOUR_MS
  return Number.isFinite(hours) ? Math.max(1, hours) : 1
}

/** Average bytes stored over the range, the value compared with plan storage and priced. */
export function billableStorageBytes(byteHours: number, start: string | Date, end: string | Date): number {
  if (!Number.isFinite(byteHours) || byteHours <= 0)
    return 0
  return Math.ceil(byteHours / hoursInRange(start, end))
}

/** GB-hours a plan with `storageGb` GB includes over the range. */
export function includedStorageGbHours(storageGb: number, start: string | Date, end: string | Date): number {
  if (!Number.isFinite(storageGb) || storageGb <= 0)
    return 0
  return storageGb * hoursInRange(start, end)
}
