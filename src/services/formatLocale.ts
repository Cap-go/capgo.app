import { getActivePinia } from 'pinia'
import { i18n } from '~/modules/i18n'
import { useMainStore } from '~/stores/main'

export const DEFAULT_FORMAT_LOCALE = 'en-GB'

const FORMAT_SAMPLE_DATE = new Date(2026, 6, 13)
const FORMAT_SAMPLE_NUMBER = 1234567.89

export const FORMAT_LOCALE_REGIONS = [
  { countryCode: 'AE', locale: 'ar-AE' },
  { countryCode: 'AR', locale: 'es-AR' },
  { countryCode: 'AT', locale: 'de-AT' },
  { countryCode: 'AU', locale: 'en-AU' },
  { countryCode: 'BE', locale: 'nl-BE' },
  { countryCode: 'BR', locale: 'pt-BR' },
  { countryCode: 'CA', locale: 'en-CA' },
  { countryCode: 'CH', locale: 'de-CH' },
  { countryCode: 'CL', locale: 'es-CL' },
  { countryCode: 'CN', locale: 'zh-CN' },
  { countryCode: 'CO', locale: 'es-CO' },
  { countryCode: 'DE', locale: 'de-DE' },
  { countryCode: 'DK', locale: 'da-DK' },
  { countryCode: 'ES', locale: 'es-ES' },
  { countryCode: 'FI', locale: 'fi-FI' },
  { countryCode: 'FR', locale: 'fr-FR' },
  { countryCode: 'GB', locale: 'en-GB' },
  { countryCode: 'HK', locale: 'en-HK' },
  { countryCode: 'ID', locale: 'id-ID' },
  { countryCode: 'IE', locale: 'en-IE' },
  { countryCode: 'IL', locale: 'en-IL' },
  { countryCode: 'IN', locale: 'en-IN' },
  { countryCode: 'IT', locale: 'it-IT' },
  { countryCode: 'JP', locale: 'ja-JP' },
  { countryCode: 'KR', locale: 'ko-KR' },
  { countryCode: 'MX', locale: 'es-MX' },
  { countryCode: 'NL', locale: 'nl-NL' },
  { countryCode: 'NO', locale: 'nb-NO' },
  { countryCode: 'NZ', locale: 'en-NZ' },
  { countryCode: 'PL', locale: 'pl-PL' },
  { countryCode: 'PT', locale: 'pt-PT' },
  { countryCode: 'RU', locale: 'ru-RU' },
  { countryCode: 'SA', locale: 'ar-SA-u-ca-gregory-nu-latn' },
  { countryCode: 'SE', locale: 'sv-SE' },
  { countryCode: 'SG', locale: 'en-SG' },
  { countryCode: 'TH', locale: 'th-TH-u-ca-gregory-nu-latn' },
  { countryCode: 'TR', locale: 'tr-TR' },
  { countryCode: 'TW', locale: 'zh-TW' },
  { countryCode: 'UA', locale: 'uk-UA' },
  { countryCode: 'US', locale: 'en-US' },
  { countryCode: 'VN', locale: 'vi-VN' },
  { countryCode: 'ZA', locale: 'en-ZA' },
] as const

export interface FormatLocaleOption {
  label: string
  value: string
}

function getCanonicalLocale(locale: string) {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null
  }
  catch {
    return null
  }
}

export function normalizeFormatLocale(locale?: string | null) {
  const canonical = getCanonicalLocale(String(locale || '').trim())
  if (!canonical)
    return null

  const hasDateSupport = Intl.DateTimeFormat.supportedLocalesOf([canonical]).length > 0
  const hasNumberSupport = Intl.NumberFormat.supportedLocalesOf([canonical]).length > 0
  return hasDateSupport && hasNumberSupport ? canonical : null
}

export function resolveFormatLocale(locale?: string | null) {
  return normalizeFormatLocale(locale) ?? DEFAULT_FORMAT_LOCALE
}

function getAccountFormatLocale() {
  if (!getActivePinia())
    return null

  return useMainStore().user?.format_locale ?? null
}

export function getFormatLocale() {
  return resolveFormatLocale(getAccountFormatLocale())
}

export function formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(getFormatLocale(), options).format(value)
}

export function formatNumberValue(value: number | null | undefined, options?: Intl.NumberFormatOptions) {
  return formatNumber(Number(value ?? 0), options)
}

export function formatOneDecimal(value: number | null | undefined) {
  return formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

export function getFormatLocaleOptions(displayLanguage?: string | null): FormatLocaleOption[] {
  const language = String(displayLanguage || i18n.global.locale.value || 'en')
  const regionNames = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames([language], { type: 'region' })
    : null

  return FORMAT_LOCALE_REGIONS.map(({ countryCode, locale }) => {
    const countryName = regionNames?.of(countryCode) ?? countryCode
    const dateSample = new Intl.DateTimeFormat(locale).format(FORMAT_SAMPLE_DATE)
    const numberSample = new Intl.NumberFormat(locale).format(FORMAT_SAMPLE_NUMBER)

    return {
      label: `${countryName} - ${dateSample} - ${numberSample}`,
      value: locale,
    }
  }).sort((left, right) => left.label.localeCompare(right.label, language))
}
