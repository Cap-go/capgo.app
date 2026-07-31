import { formatNumberValue } from '~/services/formatLocale'

export function toFixed(value: number, fixed: number) {
  if (fixed === 0)
    return value
  const factor = 10 ** fixed
  return Math.round((value + Number.EPSILON) * factor) / factor
}
export function bytesToGb(bytes: number, fixes = 0) {
  return toFixed(Math.round(((bytes / 1024.0 / 1024.0 / 1024.0) + Number.EPSILON) * 100) / 100, fixes)
}
/**
 * Formats bytes to a human-readable string with the appropriate unit (B, KB, MB, GB, TB).
 * Automatically picks the right unit based on the size.
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0)
    return '0 B'
  if (!Number.isFinite(bytes) || bytes < 0)
    return '0 B'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const index = Math.min(i, sizes.length - 1)

  return `${formatNumberValue(toFixed(bytes / k ** index, dm), { maximumFractionDigits: dm })} ${sizes[index]}`
}

export function getDaysBetweenDates(date1: string | Date, date2: string | Date) {
  const oneDay = 24 * 60 * 60 * 1000
  const firstDate = new Date(date1)
  const secondDate = new Date(date2)
  // Normalize both dates to midnight (start of day) to avoid timezone/time-of-day issues
  firstDate.setHours(0, 0, 0, 0)
  secondDate.setHours(0, 0, 0, 0)
  const res = Math.round(Math.abs((firstDate.valueOf() - secondDate.valueOf()) / oneDay))
  return res
}

export type ChecksumType = 'sha256' | 'crc32' | 'unknown'

export interface ChecksumInfo {
  type: ChecksumType
  label: string
  minPluginVersion: string
  features: string[]
}

/**
 * Detects the checksum algorithm type based on the hash string length.
 * SHA-256 = 64 hex characters (256 bits)
 * CRC32 = 8 hex characters (32 bits)
 *
 * Algorithm selection in CLI:
 * - SHA-256: Used with V2 encryption OR v6+, v7+, v8+
 * - CRC32: Used with v5 without V2 encryption
 */
export function getChecksumInfo(checksum: string | null | undefined): ChecksumInfo {
  if (!checksum) {
    return {
      type: 'unknown',
      label: 'Unknown',
      minPluginVersion: '-',
      features: [],
    }
  }

  const length = checksum.length

  // SHA-256: 64 hex characters
  // Used with V2 encryption OR plugin v6+, v7+, v8+
  if (length === 64) {
    return {
      type: 'sha256',
      label: 'SHA-256',
      minPluginVersion: 'v5 + encryption, v6, v7, v8',
      features: ['integrity-verification', 'corruption-detection', 'security'],
    }
  }

  // CRC32: 8 hex characters
  // Used with v5 without V2 encryption
  if (length === 8) {
    return {
      type: 'crc32',
      label: 'CRC32',
      minPluginVersion: 'v5 without encryption',
      features: ['fast-verification', 'corruption-detection'],
    }
  }

  return {
    type: 'unknown',
    label: 'Unknown',
    minPluginVersion: '-',
    features: [],
  }
}
