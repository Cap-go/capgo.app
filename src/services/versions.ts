import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import dayjs from 'dayjs'
import { toast } from 'vue-sonner'
import { i18n } from '~/modules/i18n'
import { hideLoader, showLoader } from './loader'
import { downloadUrl } from './supabase'

type AppVersionRow = Database['public']['Tables']['app_versions']['Row']

export function isInternalVersionName(version: string) {
  if (!version)
    return false
  return version === 'builtin' || version === 'unknown'
}

export function createBuiltinChannelVersion(channel: {
  app_id: string
  created_at: string | null
  owner_org?: string | null
}): AppVersionRow {
  return {
    app_id: channel.app_id,
    checksum: null,
    cli_version: null,
    comment: null,
    created_at: channel.created_at,
    created_by_apikey_rbac_id: null,
    deleted: false,
    deleted_at: null,
    external_url: null,
    id: 0,
    key_id: null,
    link: null,
    manifest: null,
    manifest_count: 0,
    min_update_version: null,
    name: 'builtin',
    native_packages: null,
    owner_org: channel.owner_org ?? '',
    r2_path: null,
    session_key: null,
    storage_provider: 'r2',
    updated_at: null,
    user_id: null,
  }
}

export function withBuiltinChannelVersion<T extends {
  app_id: string
  created_at: string | null
  owner_org?: string | null
  version?: AppVersionRow | null
}>(channel: T): Omit<T, 'version'> & { version: AppVersionRow } {
  return {
    ...channel,
    version: channel.version ?? createBuiltinChannelVersion(channel),
  }
}

export async function openVersion(app: Database['public']['Tables']['app_versions']['Row']) {
  const { t } = i18n.global

  let signedURL
  if (app.r2_path)
    signedURL = await downloadUrl(app.storage_provider, app.user_id ?? '', app.app_id, app.id)
  else
    signedURL = app.external_url

  if (!signedURL) {
    toast.error(t('cannot-get-the-test-'))
    return
  }
  if (!Capacitor.isNativePlatform()) {
    window.location.assign(signedURL)
    return
  }
  // native platform test the bundle in the app
  showLoader()
  try {
    const newBundle = await CapacitorUpdater.download({
      url: signedURL,
      version: app.name,
    })
    const current = await CapacitorUpdater.current()
    // Make the old bundle auto revert to it after 1 hour
    await CapacitorUpdater.next({ id: current.bundle.id })
    // iso date in one hour with dayjs
    const expires = dayjs().add(1, 'hour').toISOString()
    await CapacitorUpdater.setMultiDelay({ delayConditions: [{ kind: 'date', value: expires }] })
    // set the new bundle
    await CapacitorUpdater.set(newBundle)
  }
  catch (error) {
    console.error('Error', error)
    toast.error(t('cannot-set-this-vers'))
  }
  hideLoader()
}
