import type { Database } from '~/types/supabase.types'

type ChannelUpdatePackage = Database['public']['Enums']['channel_update_package']

type Translate = (key: string) => string

export function getUpdatePackageLabel(
  t: Translate,
  value?: ChannelUpdatePackage | null,
) {
  switch (value) {
    case 'zip':
      return t('update-package-zip')
    case 'delta':
      return t('update-package-delta')
    case 'zip_from_builtin':
      return t('update-package-zip-from-builtin')
    case 'delta_from_builtin':
      return t('update-package-delta-from-builtin')
    default:
      return t('update-package-all')
  }
}

export function getUpdatePackageDescription(
  t: Translate,
  value: ChannelUpdatePackage,
) {
  switch (value) {
    case 'zip':
      return t('update-package-zip-description')
    case 'delta':
      return t('update-package-delta-description')
    case 'zip_from_builtin':
      return t('update-package-zip-from-builtin-description')
    case 'delta_from_builtin':
      return t('update-package-delta-from-builtin-description')
    default:
      return t('update-package-all-description')
  }
}

export function getUpdatePackageInfoDescription(
  t: Translate,
  value?: ChannelUpdatePackage | null,
) {
  const current = value ?? 'all'
  return `${t('update-package-help')}\n\n${getUpdatePackageLabel(t, current)}\n${getUpdatePackageDescription(t, current)}`
}
