import countryCodeToFlagEmoji from 'country-code-to-flag-emoji'
import { toast } from 'vue-sonner'
import { getSelectedLanguage, i18n, loadLanguageAsync, normalizeLanguage, RemoteLanguageError } from '../modules/i18n'

const countryCodes: Record<string, string> = {
  'en': 'US',
  'hi': 'IN',
  'ja': 'JP',
  'ko': 'KR',
  'pt-br': 'BR',
  'vi': 'VN',
  'zh-cn': 'CN',
}

export function getEmoji(locale: string) {
  return countryCodeToFlagEmoji((countryCodes[locale] ?? locale).toUpperCase())
}

export async function changeLanguage(lang: string) {
  const currentLanguage = getSelectedLanguage()
  const nextLanguage = normalizeLanguage(lang)

  if (currentLanguage === nextLanguage)
    return currentLanguage

  try {
    await loadLanguageAsync(nextLanguage)
    return nextLanguage
  }
  catch (error) {
    if (error instanceof RemoteLanguageError && error.reason === 'pending')
      toast.info(i18n.global.t('translation-not-ready'))
    else
      toast.error(i18n.global.t('translation-unavailable'))

    return currentLanguage
  }
}
