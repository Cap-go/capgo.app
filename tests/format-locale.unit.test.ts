import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { FORMAT_LOCALE_REGIONS, formatNumberValue, getFormatLocale, getFormatLocaleOptions, resolveFormatLocale } from '../src/services/formatLocale'
import { useMainStore } from '../src/stores/main'

describe('format locale helpers', () => {
  it.concurrent('keeps explicit regional conventions separate from language', () => {
    expect(resolveFormatLocale('en-US')).toBe('en-US')
    expect(resolveFormatLocale('fr-FR')).toBe('fr-FR')
    expect(resolveFormatLocale('pt-BR')).toBe('pt-BR')
    expect(resolveFormatLocale('not-a-locale')).toBe('en-GB')
  })

  it('uses the account format locale from the main store', () => {
    setActivePinia(createPinia())
    const main = useMainStore()
    main.user = {
      ban_time: null,
      country: 'France',
      created_at: null,
      created_via_invite: false,
      discord_username: null,
      email: 'test@capgo.app',
      email_preferences: {},
      enable_notifications: true,
      first_name: 'Test',
      format_locale: 'fr-FR',
      github_username: null,
      id: '00000000-0000-0000-0000-000000000000',
      image_url: null,
      last_name: 'User',
      opt_for_newsletters: false,
      updated_at: null,
    }

    expect(getFormatLocale()).toBe('fr-FR')
    expect(formatNumberValue(1234567.89)).toBe(new Intl.NumberFormat('fr-FR').format(1234567.89))
    setActivePinia(createPinia())
  })

  it.concurrent('maps countries to locales that carry their date and number conventions', () => {
    expect(FORMAT_LOCALE_REGIONS.find(region => region.countryCode === 'BR')?.locale).toBe('pt-BR')
    expect(FORMAT_LOCALE_REGIONS.find(region => region.countryCode === 'RU')?.locale).toBe('ru-RU')
    expect(FORMAT_LOCALE_REGIONS.find(region => region.countryCode === 'TR')?.locale).toBe('tr-TR')
    expect(FORMAT_LOCALE_REGIONS.find(region => region.countryCode === 'TH')?.locale).toBe('th-TH-u-ca-gregory-nu-latn')
  })

  it.concurrent('lists country convention options with date and number samples', () => {
    const options = getFormatLocaleOptions('en')
    const france = options.find(option => option.value === 'fr-FR')
    const brazil = options.find(option => option.value === 'pt-BR')
    const us = options.find(option => option.value === 'en-US')

    expect(france?.label).toContain(new Intl.DateTimeFormat('fr-FR').format(new Date(2026, 6, 13)))
    expect(france?.label).toContain(new Intl.NumberFormat('fr-FR').format(1234567.89))
    expect(brazil?.label).toContain(new Intl.DateTimeFormat('pt-BR').format(new Date(2026, 6, 13)))
    expect(brazil?.label).toContain(new Intl.NumberFormat('pt-BR').format(1234567.89))
    expect(us?.label).toContain(new Intl.DateTimeFormat('en-US').format(new Date(2026, 6, 13)))
  })
})
