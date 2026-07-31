import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatBytes, toFixed } from '../src/services/conversion'
import { useMainStore } from '../src/stores/main'

function setAccountFormatLocale(formatLocale: string) {
  setActivePinia(createPinia())
  const main = useMainStore()
  main.user = { format_locale: formatLocale } as typeof main.user
}

describe('conversion helpers', () => {
  beforeEach(() => {
    setAccountFormatLocale('en-GB')
  })

  it('rounds fixed decimals without binary precision drift', () => {
    expect(toFixed(1.005, 2)).toBe(1.01)
    expect(toFixed(12.34, 0)).toBe(12.34)
  })

  it('formats bytes with the account number convention', () => {
    setAccountFormatLocale('fr-FR')

    expect(formatBytes(1536, 2)).toBe('1,5 KB')
    expect(formatBytes(1024 * 1.005, 2)).toBe('1,01 KB')
  })

  it('keeps invalid and empty byte values at zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})
