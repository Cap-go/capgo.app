<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconCheckCircle from '~icons/lucide/check-circle-2'
import IconDownload from '~icons/lucide/download'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconRocket from '~icons/lucide/rocket'
import IconTrash from '~icons/lucide/trash-2'
import IconAndroid from '~icons/mdi/android'
import IconApple from '~icons/mdi/apple'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'

type StorePlatform = 'ios' | 'android'

interface CredentialSummary {
  platform: StorePlatform
  updated_at: string
  metadata: Record<string, any>
}

interface StoreBuild {
  id: string
  builder_job_id: string | null
  platform: StorePlatform
  status: string
  last_error: string | null
  created_at: string
}

interface StoreState {
  app_id: string
  bundle_id: string
  template_version: string
  update_mode: string
  website_url: string | null
  config: {
    app_name: string | null
    version_name: string
    icon_background_color: string
    submit_for_review: boolean
  }
  icon_preview_url: string | null
  credentials: Record<StorePlatform, CredentialSummary | null>
  readiness: Record<StorePlatform, { ready: boolean, missing: string[] }>
  builds: StoreBuild[]
}

interface WebsiteCheck {
  url: string
  final_url: string
  compatible: boolean
  rendering: string
  checks: { id: string, status: 'pass' | 'warning' | 'fail', essential: boolean, detail: string }[]
  details: { app_name: string | null, theme_color: string | null }
}

class StoreRequestError extends Error {
  constructor(message: string, readonly code: string | null, readonly moreInfo: Record<string, any> | null) {
    super(message)
  }
}

interface GeneratedKeystore {
  keystore_base64: string
  key_alias: string
  password: string
}

const ACTIVE_BUILD_STATUSES = new Set(['pending', 'queued', 'reserved', 'waiting_runner', 'running', 'uploading'])
const MIN_ICON_SIZE = 512
const MAX_ICON_SIZE = 2048

const { t } = useI18n()
const route = useRoute()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()

const appId = ref('')
const state = ref<StoreState | null>(null)
const loadError = ref('')
const isLoading = ref(false)
const busy = ref<string | null>(null)

const websiteUrl = ref('')
const appName = ref('')
const versionName = ref('1.0.0')
const iconBackgroundColor = ref('#FFFFFF')
const submitForReview = ref(true)

const iosMode = ref<'automatic' | 'manual'>('automatic')
const ascKeyId = ref('')
const ascIssuerId = ref('')
const ascPrivateKey = ref('')
const ascPrivateKeyFileName = ref('')
const certificateBase64 = ref('')
const certificateFileName = ref('')
const certificatePassword = ref('')
const profileBase64 = ref('')
const profileFileName = ref('')

const androidKeystoreSource = ref<'generate' | 'upload'>('generate')
const keystoreBase64 = ref('')
const keystoreFileName = ref('')
const keyAlias = ref('')
const keyPassword = ref('')
const storePassword = ref('')
const playServiceAccountJson = ref('')
const playServiceAccountFileName = ref('')
const generatedKeystore = ref<GeneratedKeystore | null>(null)
const websiteCheck = ref<WebsiteCheck | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

const hasActiveBuild = computed(() => state.value?.builds.some(build => ACTIVE_BUILD_STATUSES.has(build.status)) ?? false)
const isWebsiteLive = computed(() => state.value?.update_mode === 'website' && !!state.value?.website_url)
const iosCredentials = computed(() => state.value?.credentials.ios ?? null)
const androidCredentials = computed(() => state.value?.credentials.android ?? null)

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token)
    throw new Error(t('not-authenticated'))
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function storeFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${defaultApiHost}/website_live_store${path}`, {
    ...init,
    headers: { ...(await authHeaders()), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  if (!response.ok)
    throw new StoreRequestError(json?.message || json?.error || response.statusText, json?.error ?? null, json?.moreInfo ?? null)
  return json as T
}

function applyState(next: StoreState) {
  state.value = next
  websiteUrl.value = next.website_url ?? ''
  appName.value = next.config.app_name ?? ''
  versionName.value = next.config.version_name
  iconBackgroundColor.value = next.config.icon_background_color
  submitForReview.value = next.config.submit_for_review
  const ios = next.credentials.ios?.metadata
  if (ios) {
    iosMode.value = ios.mode === 'manual' ? 'manual' : 'automatic'
    ascKeyId.value = ios.asc_key_id ?? ''
    ascIssuerId.value = ios.asc_issuer_id ?? ''
  }
  const android = next.credentials.android?.metadata
  if (android?.key_alias)
    keyAlias.value = android.key_alias
  syncPolling()
}

async function refresh() {
  if (!appId.value)
    return
  isLoading.value = true
  loadError.value = ''
  try {
    applyState(await storeFetch<StoreState>(`?app_id=${encodeURIComponent(appId.value)}`))
  }
  catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    isLoading.value = false
  }
}

function syncPolling() {
  if (hasActiveBuild.value && !pollTimer) {
    pollTimer = setInterval(() => {
      void refresh()
    }, 15_000)
  }
  else if (!hasActiveBuild.value && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function run(action: string, task: () => Promise<void>, success: string) {
  busy.value = action
  try {
    await task()
    toast.success(success)
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    busy.value = null
  }
}

function saveDetails(force = false) {
  return run('details', async () => {
    try {
      const next = await storeFetch<StoreState & { website_check: WebsiteCheck | null }>('', {
        method: 'PUT',
        body: JSON.stringify({
          app_id: appId.value,
          website_url: websiteUrl.value.trim() || undefined,
          app_name: appName.value.trim() || undefined,
          version_name: versionName.value.trim(),
          icon_background_color: iconBackgroundColor.value.toUpperCase(),
          submit_for_review: submitForReview.value,
          force: force || undefined,
        }),
      })
      if (next.website_check)
        websiteCheck.value = next.website_check
      applyState(next)
    }
    catch (error) {
      if (error instanceof StoreRequestError && error.code === 'website_not_compatible' && error.moreInfo?.website_check)
        websiteCheck.value = error.moreInfo.website_check
      throw error
    }
  }, t('store-publish-saved'))
}

function checkWebsite() {
  return run('check', async () => {
    websiteCheck.value = await storeFetch<WebsiteCheck>('/check', {
      method: 'POST',
      body: JSON.stringify({ app_id: appId.value, website_url: websiteUrl.value.trim() || undefined }),
    })
  }, t('store-publish-website-checked'))
}

const WEBSITE_CHECK_LABELS: Record<string, string> = {
  public_html: 'store-publish-check-public-html',
  same_origin: 'store-publish-check-same-origin',
  static_shell: 'store-publish-check-static-shell',
  cacheable: 'store-publish-check-cacheable',
  cookies: 'store-publish-check-cookies',
  same_origin_assets: 'store-publish-check-same-origin-assets',
  service_worker: 'store-publish-check-service-worker',
  mobile_viewport: 'store-publish-check-mobile-viewport',
}

function websiteCheckLabel(id: string) {
  const key = WEBSITE_CHECK_LABELS[id]
  return key ? t(key) : id
}

function readFile(file: File, as: 'text' | 'base64'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(as === 'text' ? result : result.slice(result.indexOf(',') + 1))
    }
    if (as === 'text')
      reader.readAsText(file)
    else
      reader.readAsDataURL(file)
  })
}

function pickedFile(event: Event): File | null {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  return file
}

/** Any browser-readable image becomes a square-ish PNG the API accepts. */
async function imageToPngBase64(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  if (side < MIN_ICON_SIZE)
    throw new Error(t('store-publish-icon-too-small'))
  const size = Math.min(side, MAX_ICON_SIZE)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context)
    throw new Error(t('store-publish-icon-invalid'))
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob)
    throw new Error(t('store-publish-icon-invalid'))
  return readFile(new File([blob], 'icon.png', { type: 'image/png' }), 'base64')
}

function uploadIcon(event: Event) {
  const file = pickedFile(event)
  if (!file)
    return
  void run('icon', async () => {
    const imageBase64 = await imageToPngBase64(file)
    applyState(await storeFetch<StoreState>('/icon', {
      method: 'POST',
      body: JSON.stringify({ app_id: appId.value, image_base64: imageBase64, background_color: iconBackgroundColor.value.toUpperCase() }),
    }))
  }, t('store-publish-icon-saved'))
}

function useWebsiteIcon() {
  return run('icon', async () => {
    applyState(await storeFetch<StoreState>('/icon', {
      method: 'POST',
      body: JSON.stringify({ app_id: appId.value, from_website: true, background_color: iconBackgroundColor.value.toUpperCase() }),
    }))
  }, t('store-publish-icon-saved'))
}

async function pickAscKey(event: Event) {
  const file = pickedFile(event)
  if (!file)
    return
  ascPrivateKey.value = await readFile(file, 'text')
  ascPrivateKeyFileName.value = file.name
  const keyIdFromName = /AuthKey_([A-Z0-9]+)\.p8$/i.exec(file.name)?.[1]
  if (keyIdFromName && !ascKeyId.value)
    ascKeyId.value = keyIdFromName.toUpperCase()
}

async function pickCertificate(event: Event) {
  const file = pickedFile(event)
  if (!file)
    return
  certificateBase64.value = await readFile(file, 'base64')
  certificateFileName.value = file.name
}

async function pickProfile(event: Event) {
  const file = pickedFile(event)
  if (!file)
    return
  profileBase64.value = await readFile(file, 'base64')
  profileFileName.value = file.name
}

async function pickKeystore(event: Event) {
  const file = pickedFile(event)
  if (!file)
    return
  keystoreBase64.value = await readFile(file, 'base64')
  keystoreFileName.value = file.name
}

async function pickPlayServiceAccount(event: Event) {
  const file = pickedFile(event)
  if (!file)
    return
  playServiceAccountJson.value = await readFile(file, 'text')
  playServiceAccountFileName.value = file.name
}

function saveIosKeys() {
  return run('ios', async () => {
    const response = await storeFetch<{ state: StoreState }>('/credentials', {
      method: 'PUT',
      body: JSON.stringify({
        app_id: appId.value,
        platform: 'ios',
        mode: iosMode.value,
        asc_key_id: ascKeyId.value.trim(),
        asc_issuer_id: ascIssuerId.value.trim(),
        asc_private_key: ascPrivateKey.value,
        ...(iosMode.value === 'manual'
          ? {
              certificate_p12_base64: certificateBase64.value,
              certificate_password: certificatePassword.value,
              provisioning_profile_base64: profileBase64.value,
            }
          : {}),
      }),
    })
    ascPrivateKey.value = ''
    ascPrivateKeyFileName.value = ''
    certificateBase64.value = ''
    certificatePassword.value = ''
    profileBase64.value = ''
    applyState(response.state)
  }, t('store-publish-keys-saved'))
}

function saveAndroidKeys() {
  return run('android', async () => {
    const hasKeystore = !!androidCredentials.value
    const response = await storeFetch<{ state: StoreState, generated_keystore: GeneratedKeystore | null }>('/credentials', {
      method: 'PUT',
      body: JSON.stringify({
        app_id: appId.value,
        platform: 'android',
        ...(!hasKeystore && androidKeystoreSource.value === 'generate' ? { generate_keystore: true } : {}),
        ...(!hasKeystore && androidKeystoreSource.value === 'upload'
          ? {
              keystore_base64: keystoreBase64.value,
              key_alias: keyAlias.value.trim(),
              key_password: keyPassword.value || undefined,
              store_password: storePassword.value,
            }
          : {}),
        ...(playServiceAccountJson.value ? { play_service_account_json: playServiceAccountJson.value } : {}),
      }),
    })
    keystoreBase64.value = ''
    keyPassword.value = ''
    storePassword.value = ''
    playServiceAccountJson.value = ''
    generatedKeystore.value = response.generated_keystore
    applyState(response.state)
  }, t('store-publish-keys-saved'))
}

function downloadKeystore(keystore: GeneratedKeystore) {
  const bytes = Uint8Array.from(atob(keystore.keystore_base64), char => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-pkcs12' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${appId.value}-upload-keystore.p12`
  link.click()
  URL.revokeObjectURL(url)
}

function exportKeystore() {
  return run('export', async () => {
    const exported = await storeFetch<{ keystore_base64: string, key_alias: string, store_password: string }>('/credentials/android/export', {
      method: 'POST',
      body: JSON.stringify({ app_id: appId.value }),
    })
    generatedKeystore.value = { keystore_base64: exported.keystore_base64, key_alias: exported.key_alias, password: exported.store_password }
    downloadKeystore(generatedKeystore.value)
  }, t('store-publish-keystore-downloaded'))
}

function deleteKeys(platform: StorePlatform) {
  dialogStore.openDialog({
    title: t('store-publish-delete-keys-title'),
    description: platform === 'android' ? t('store-publish-delete-android-keys-message') : t('store-publish-delete-ios-keys-message'),
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      {
        text: t('delete'),
        role: 'danger',
        handler: async () => {
          await run(`delete-${platform}`, async () => {
            applyState(await storeFetch<StoreState>(`/credentials?app_id=${encodeURIComponent(appId.value)}&platform=${platform}`, { method: 'DELETE' }))
            if (platform === 'android')
              generatedKeystore.value = null
          }, t('store-publish-keys-deleted'))
        },
      },
    ],
  })
}

function publish(platform: StorePlatform) {
  return run(`publish-${platform}`, async () => {
    await storeFetch('/publish', {
      method: 'POST',
      body: JSON.stringify({ app_id: appId.value, platform }),
    })
    await refresh()
  }, t('store-publish-started'))
}

function missingLabel(key: string) {
  return t(`store-publish-missing-${key.replace(/_/g, '-')}`)
}

function buildStatusClass(status: string) {
  if (status === 'succeeded' || status === 'success' || status === 'completed')
    return 'text-green-700 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-900/20 dark:border-green-800'
  if (status === 'failed' || status === 'cancelled' || status === 'timeout')
    return 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-900/20 dark:border-red-800'
  return 'text-azure-700 bg-azure-500/10 border-azure-500/40 dark:text-azure-200'
}

watch(() => route.params, (params) => {
  const value = (params as { app?: string | string[] }).app
  const next = Array.isArray(value) ? value[0] : value
  if (next && next !== appId.value) {
    appId.value = next
    generatedKeystore.value = null
    void refresh()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (pollTimer)
    clearInterval(pollTimer)
})
</script>

<template>
  <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-6xl" data-test="store-publish-page">
    <div class="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-slate-900 dark:text-white">
          {{ t('store-publish-title') }}
        </h1>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300 max-w-3xl">
          {{ t('store-publish-description') }}
        </p>
      </div>
      <button type="button" class="self-start d-btn d-btn-sm d-btn-outline" :disabled="isLoading" @click="refresh">
        <span v-if="isLoading" class="d-loading d-loading-spinner d-loading-xs" />
        <IconRefresh v-else class="w-4 h-4" aria-hidden="true" />
        {{ t('refresh') }}
      </button>
    </div>

    <div v-if="loadError" class="mx-4 p-4 text-sm text-red-700 border border-red-200 rounded-xl bg-red-50 dark:text-red-200 dark:bg-red-900/20 dark:border-red-800" role="alert">
      {{ loadError }}
    </div>

    <div v-else-if="!state" class="flex justify-center py-16">
      <span class="d-loading d-loading-spinner d-loading-md" />
    </div>

    <div v-else class="flex flex-col gap-6 px-4">
      <!-- App details -->
      <section class="p-5 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-test="store-publish-details">
        <h2 class="text-base font-semibold text-slate-900 dark:text-white">
          1. {{ t('store-publish-details-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('store-publish-details-description', { bundleId: state.bundle_id }) }}
        </p>
        <div class="grid gap-4 mt-4 md:grid-cols-2">
          <div class="md:col-span-2">
            <label for="store-website-url" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-website-url') }}</label>
            <input id="store-website-url" v-model="websiteUrl" type="url" inputmode="url" class="w-full d-input d-input-bordered" placeholder="https://app.example.com" data-test="store-website-url">
            <p v-if="!isWebsiteLive" class="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {{ t('store-publish-website-url-hint') }}
            </p>
            <div v-if="websiteCheck" class="p-3 mt-3 text-sm border rounded-lg" :class="websiteCheck.compatible ? 'border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800' : 'border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800'" data-test="store-website-check">
              <p class="font-medium" :class="websiteCheck.compatible ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200'">
                {{ websiteCheck.compatible ? t('store-publish-website-compatible', { rendering: websiteCheck.rendering }) : t('store-publish-website-not-compatible') }}
              </p>
              <ul class="mt-2 space-y-1">
                <li v-for="check in websiteCheck.checks" :key="check.id" class="flex gap-2">
                  <IconCheckCircle v-if="check.status === 'pass'" class="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                  <IconAlertCircle v-else class="w-4 h-4 mt-0.5 shrink-0" :class="check.status === 'fail' ? 'text-red-600' : 'text-amber-600'" />
                  <span class="text-slate-700 dark:text-slate-200"><span class="font-medium">{{ websiteCheckLabel(check.id) }}:</span> {{ check.detail }}</span>
                </li>
              </ul>
              <button v-if="!websiteCheck.compatible" type="button" class="mt-3 d-btn d-btn-outline d-btn-error d-btn-xs" :disabled="busy !== null" data-test="store-save-anyway" @click="saveDetails(true)">
                {{ t('store-publish-save-anyway') }}
              </button>
            </div>
          </div>
          <div>
            <label for="store-app-name" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-app-name') }}</label>
            <input id="store-app-name" v-model="appName" type="text" maxlength="30" class="w-full d-input d-input-bordered" data-test="store-app-name">
          </div>
          <div>
            <label for="store-version" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-version') }}</label>
            <input id="store-version" v-model="versionName" type="text" class="w-full d-input d-input-bordered" placeholder="1.0.0">
          </div>
          <label class="flex items-center gap-3 md:col-span-2">
            <input v-model="submitForReview" type="checkbox" class="d-toggle d-toggle-primary">
            <span class="text-sm text-slate-700 dark:text-slate-200">{{ t('store-publish-submit-for-review') }}</span>
          </label>
        </div>
        <div class="flex justify-end gap-2 mt-4">
          <button type="button" class="d-btn d-btn-outline d-btn-sm" :disabled="busy !== null || !websiteUrl.trim()" data-test="store-check-website" @click="checkWebsite">
            <span v-if="busy === 'check'" class="d-loading d-loading-spinner d-loading-xs" />
            {{ t('store-publish-check-website') }}
          </button>
          <button type="button" class="d-btn d-btn-primary d-btn-sm" :disabled="busy !== null" data-test="store-save-details" @click="saveDetails()">
            <span v-if="busy === 'details'" class="d-loading d-loading-spinner d-loading-xs" />
            {{ t('store-publish-save') }}
          </button>
        </div>
      </section>

      <!-- Icon -->
      <section class="p-5 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-test="store-publish-icon">
        <h2 class="text-base font-semibold text-slate-900 dark:text-white">
          2. {{ t('store-publish-icon-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('store-publish-icon-description') }}
        </p>
        <div class="flex flex-col gap-5 mt-4 sm:flex-row sm:items-center">
          <div class="flex items-center justify-center w-28 h-28 overflow-hidden border shrink-0 rounded-[22%] border-slate-200 dark:border-slate-700" :style="{ backgroundColor: iconBackgroundColor }">
            <img v-if="state.icon_preview_url" :src="state.icon_preview_url" :alt="t('store-publish-icon-preview')" class="w-full h-full">
            <span v-else class="px-2 text-xs text-center text-slate-500">{{ t('store-publish-icon-empty') }}</span>
          </div>
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap gap-2">
              <label class="d-btn d-btn-sm d-btn-primary" :class="{ 'd-btn-disabled': busy !== null }">
                <span v-if="busy === 'icon'" class="d-loading d-loading-spinner d-loading-xs" />
                {{ t('store-publish-icon-upload') }}
                <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" :aria-label="t('store-publish-icon-upload')" :disabled="busy !== null" data-test="store-icon-input" @change="uploadIcon">
              </label>
              <button type="button" class="d-btn d-btn-sm d-btn-outline" :disabled="busy !== null || !isWebsiteLive" @click="useWebsiteIcon">
                {{ t('store-publish-icon-from-website') }}
              </button>
            </div>
            <div class="flex items-center gap-2">
              <label for="store-icon-background" class="text-sm text-slate-700 dark:text-slate-200">{{ t('store-publish-icon-background') }}</label>
              <input id="store-icon-background" v-model="iconBackgroundColor" type="color" class="w-10 h-8 p-0 border rounded cursor-pointer border-slate-300">
              <span class="font-mono text-xs text-slate-500">{{ iconBackgroundColor.toUpperCase() }}</span>
            </div>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('store-publish-icon-hint') }}
            </p>
          </div>
        </div>
      </section>

      <!-- iOS keys -->
      <section class="p-5 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-test="store-section-ios">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
              <IconApple class="w-5 h-5" aria-hidden="true" />
              3. {{ t('store-publish-ios-title') }}
            </h2>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {{ t('store-publish-ios-description') }}
            </p>
          </div>
          <button v-if="iosCredentials" type="button" class="d-btn d-btn-ghost d-btn-sm text-red-600" :disabled="busy !== null" :aria-label="t('store-publish-delete-keys-title')" @click="deleteKeys('ios')">
            <IconTrash class="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div v-if="iosCredentials" class="grid gap-2 p-3 mt-4 text-sm border rounded-lg sm:grid-cols-2 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-700" data-test="store-ios-summary">
          <div><span class="text-slate-500">{{ t('store-publish-signing') }}:</span> {{ iosCredentials.metadata.mode === 'manual' ? t('store-publish-ios-manual') : t('store-publish-ios-automatic') }}</div>
          <div><span class="text-slate-500">{{ t('store-publish-team') }}:</span> {{ iosCredentials.metadata.team_id }}</div>
          <div><span class="text-slate-500">{{ t('store-publish-api-key') }}:</span> {{ iosCredentials.metadata.asc_key_id }}</div>
          <div><span class="text-slate-500">{{ t('store-publish-profile') }}:</span> {{ iosCredentials.metadata.profile_name }}</div>
          <div v-if="!iosCredentials.metadata.app_store_app_found" class="flex items-start gap-2 text-amber-700 sm:col-span-2 dark:text-amber-300">
            <IconAlertCircle class="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            {{ t('store-publish-ios-app-missing', { bundleId: state.bundle_id }) }}
          </div>
        </div>
        <div class="grid gap-4 mt-4 md:grid-cols-2">
          <fieldset class="md:col-span-2">
            <legend class="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t('store-publish-signing') }}
            </legend>
            <div class="flex flex-wrap gap-4">
              <label class="flex items-center gap-2 text-sm">
                <input v-model="iosMode" type="radio" value="automatic" class="d-radio d-radio-sm">
                {{ t('store-publish-ios-automatic') }}
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input v-model="iosMode" type="radio" value="manual" class="d-radio d-radio-sm">
                {{ t('store-publish-ios-manual') }}
              </label>
            </div>
          </fieldset>
          <div>
            <label for="store-asc-key-id" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-asc-key-id') }}</label>
            <input id="store-asc-key-id" v-model="ascKeyId" type="text" class="w-full font-mono d-input d-input-bordered" placeholder="ABC123DEFG">
          </div>
          <div>
            <label for="store-asc-issuer" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-asc-issuer-id') }}</label>
            <input id="store-asc-issuer" v-model="ascIssuerId" type="text" class="w-full font-mono d-input d-input-bordered" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
          </div>
          <div class="md:col-span-2">
            <label for="store-asc-key-file" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-asc-key-file') }}</label>
            <input id="store-asc-key-file" type="file" accept=".p8" class="w-full d-file-input d-file-input-bordered d-file-input-sm" @change="pickAscKey">
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {{ ascPrivateKeyFileName || t('store-publish-asc-key-hint') }}
            </p>
          </div>
          <template v-if="iosMode === 'manual'">
            <div>
              <label for="store-p12" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-certificate') }}</label>
              <input id="store-p12" type="file" accept=".p12" class="w-full d-file-input d-file-input-bordered d-file-input-sm" @change="pickCertificate">
              <p v-if="certificateFileName" class="mt-1 text-xs text-slate-500">
                {{ certificateFileName }}
              </p>
            </div>
            <div>
              <label for="store-p12-password" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-certificate-password') }}</label>
              <input id="store-p12-password" v-model="certificatePassword" type="password" autocomplete="off" class="w-full d-input d-input-bordered">
            </div>
            <div class="md:col-span-2">
              <label for="store-profile" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-provisioning-profile') }}</label>
              <input id="store-profile" type="file" accept=".mobileprovision" class="w-full d-file-input d-file-input-bordered d-file-input-sm" @change="pickProfile">
              <p v-if="profileFileName" class="mt-1 text-xs text-slate-500">
                {{ profileFileName }}
              </p>
            </div>
          </template>
        </div>
        <div class="flex justify-end mt-4">
          <button type="button" class="d-btn d-btn-primary d-btn-sm" :disabled="busy !== null || !ascPrivateKey || !ascKeyId || !ascIssuerId" data-test="store-save-ios" @click="saveIosKeys">
            <span v-if="busy === 'ios'" class="d-loading d-loading-spinner d-loading-xs" />
            {{ iosCredentials ? t('store-publish-replace-keys') : t('store-publish-save-keys') }}
          </button>
        </div>
      </section>

      <!-- Android keys -->
      <section class="p-5 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-test="store-section-android">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
              <IconAndroid class="w-5 h-5" aria-hidden="true" />
              4. {{ t('store-publish-android-title') }}
            </h2>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {{ t('store-publish-android-description') }}
            </p>
          </div>
          <button v-if="androidCredentials" type="button" class="d-btn d-btn-ghost d-btn-sm text-red-600" :disabled="busy !== null" :aria-label="t('store-publish-delete-keys-title')" @click="deleteKeys('android')">
            <IconTrash class="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div v-if="generatedKeystore" class="p-4 mt-4 text-sm border rounded-lg border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700" role="alert" data-test="store-generated-keystore">
          <p class="font-medium text-amber-900 dark:text-amber-100">
            {{ t('store-publish-keystore-warning') }}
          </p>
          <p class="mt-2 font-mono text-xs break-all">
            {{ t('store-publish-key-alias') }}: {{ generatedKeystore.key_alias }} · {{ t('store-publish-keystore-password') }}: {{ generatedKeystore.password }}
          </p>
          <button type="button" class="mt-3 d-btn d-btn-sm d-btn-warning" :disabled="busy !== null" @click="exportKeystore">
            <IconDownload class="w-4 h-4" aria-hidden="true" />
            {{ t('store-publish-download-keystore') }}
          </button>
        </div>

        <div v-if="androidCredentials?.metadata.generated && !androidCredentials.metadata.exported_at && !generatedKeystore" class="p-4 mt-4 text-sm border rounded-lg border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700" role="alert" data-test="store-keystore-export-reminder">
          <p class="font-medium text-amber-900 dark:text-amber-100">
            {{ t('store-publish-keystore-export-reminder') }}
          </p>
        </div>

        <div v-if="androidCredentials" class="grid gap-2 p-3 mt-4 text-sm border rounded-lg sm:grid-cols-2 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-700" data-test="store-android-summary">
          <div><span class="text-slate-500">{{ t('store-publish-key-alias') }}:</span> {{ androidCredentials.metadata.key_alias }}</div>
          <div><span class="text-slate-500">{{ t('store-publish-keystore') }}:</span> {{ androidCredentials.metadata.generated ? t('store-publish-keystore-generated') : t('store-publish-keystore-uploaded') }}</div>
          <div v-if="androidCredentials.metadata.sha256" class="font-mono text-xs break-all sm:col-span-2">
            SHA-256: {{ androidCredentials.metadata.sha256 }}
          </div>
          <div class="sm:col-span-2">
            <span class="text-slate-500">{{ t('store-publish-play-access') }}:</span>
            {{ androidCredentials.metadata.play_client_email || t('store-publish-play-access-missing') }}
          </div>
          <div class="sm:col-span-2">
            <button type="button" class="d-btn d-btn-xs d-btn-outline" :disabled="busy !== null" @click="exportKeystore">
              <IconDownload class="w-3 h-3" aria-hidden="true" />
              {{ t('store-publish-download-keystore') }}
            </button>
          </div>
        </div>

        <div class="grid gap-4 mt-4 md:grid-cols-2">
          <fieldset v-if="!androidCredentials" class="md:col-span-2">
            <legend class="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ t('store-publish-keystore') }}
            </legend>
            <div class="flex flex-wrap gap-4">
              <label class="flex items-center gap-2 text-sm">
                <input v-model="androidKeystoreSource" type="radio" value="generate" class="d-radio d-radio-sm">
                {{ t('store-publish-keystore-generate') }}
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input v-model="androidKeystoreSource" type="radio" value="upload" class="d-radio d-radio-sm">
                {{ t('store-publish-keystore-upload') }}
              </label>
            </div>
          </fieldset>
          <template v-if="!androidCredentials && androidKeystoreSource === 'upload'">
            <div class="md:col-span-2">
              <label for="store-keystore" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-keystore-file') }}</label>
              <input id="store-keystore" type="file" accept=".jks,.keystore,.p12" class="w-full d-file-input d-file-input-bordered d-file-input-sm" @change="pickKeystore">
              <p v-if="keystoreFileName" class="mt-1 text-xs text-slate-500">
                {{ keystoreFileName }}
              </p>
            </div>
            <div>
              <label for="store-key-alias" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-key-alias') }}</label>
              <input id="store-key-alias" v-model="keyAlias" type="text" class="w-full d-input d-input-bordered">
            </div>
            <div>
              <label for="store-store-password" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-keystore-password') }}</label>
              <input id="store-store-password" v-model="storePassword" type="password" autocomplete="off" class="w-full d-input d-input-bordered">
            </div>
            <div>
              <label for="store-key-password" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-key-password') }}</label>
              <input id="store-key-password" v-model="keyPassword" type="password" autocomplete="off" class="w-full d-input d-input-bordered" :placeholder="t('store-publish-key-password-placeholder')">
            </div>
          </template>
          <div class="md:col-span-2">
            <label for="store-play-json" class="block mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('store-publish-play-service-account') }}</label>
            <input id="store-play-json" type="file" accept=".json,application/json" class="w-full d-file-input d-file-input-bordered d-file-input-sm" @change="pickPlayServiceAccount">
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {{ playServiceAccountFileName || t('store-publish-play-service-account-hint') }}
            </p>
          </div>
        </div>
        <div class="flex justify-end mt-4">
          <button
            type="button"
            class="d-btn d-btn-primary d-btn-sm"
            :disabled="busy !== null || (!!androidCredentials && !playServiceAccountJson) || (!androidCredentials && androidKeystoreSource === 'upload' && (!keystoreBase64 || !keyAlias || !storePassword))"
            data-test="store-save-android"
            @click="saveAndroidKeys"
          >
            <span v-if="busy === 'android'" class="d-loading d-loading-spinner d-loading-xs" />
            {{ androidCredentials ? t('store-publish-update-play-access') : t('store-publish-save-keys') }}
          </button>
        </div>
      </section>

      <!-- Publish -->
      <section class="p-5 bg-white border shadow-sm rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-test="store-publish-publish">
        <h2 class="text-base font-semibold text-slate-900 dark:text-white">
          5. {{ t('store-publish-publish-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ submitForReview ? t('store-publish-publish-description-review') : t('store-publish-publish-description') }}
        </p>
        <div class="grid gap-4 mt-4 md:grid-cols-2">
          <div v-for="platform in (['ios', 'android'] as const)" :key="platform" class="p-4 border rounded-lg border-slate-200 dark:border-slate-700">
            <div class="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
              <IconApple v-if="platform === 'ios'" class="w-5 h-5" aria-hidden="true" />
              <IconAndroid v-else class="w-5 h-5" aria-hidden="true" />
              {{ platform === 'ios' ? 'App Store' : 'Google Play' }}
            </div>
            <ul class="mt-3 space-y-1 text-sm">
              <li v-if="state.readiness[platform].ready" class="flex items-center gap-2 text-green-700 dark:text-green-300">
                <IconCheckCircle class="w-4 h-4" aria-hidden="true" />
                {{ t('store-publish-ready') }}
              </li>
              <li v-for="missing in state.readiness[platform].missing" :key="missing" class="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                <IconAlertCircle class="w-4 h-4" aria-hidden="true" />
                {{ missingLabel(missing) }}
              </li>
            </ul>
            <p v-if="platform === 'android'" class="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {{ t('store-publish-android-first-release') }}
            </p>
            <button type="button" class="w-full mt-4 d-btn d-btn-primary d-btn-sm" :disabled="busy !== null || !state.readiness[platform].ready" :data-test="`store-publish-${platform}`" @click="publish(platform)">
              <span v-if="busy === `publish-${platform}`" class="d-loading d-loading-spinner d-loading-xs" />
              <IconRocket v-else class="w-4 h-4" aria-hidden="true" />
              {{ platform === 'ios' ? t('store-publish-publish-ios') : t('store-publish-publish-android') }}
            </button>
          </div>
        </div>

        <div v-if="state.builds.length" class="mt-6 overflow-x-auto">
          <table class="w-full text-sm" data-test="store-builds">
            <thead>
              <tr class="text-left text-slate-500">
                <th class="py-2 pr-4 font-medium">
                  {{ t('platform') }}
                </th>
                <th class="py-2 pr-4 font-medium">
                  {{ t('status') }}
                </th>
                <th class="py-2 pr-4 font-medium">
                  {{ t('created-at') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="build in state.builds" :key="build.id" class="border-t border-slate-200 dark:border-slate-700 align-top">
                <td class="py-2 pr-4">
                  {{ build.platform === 'ios' ? 'iOS' : 'Android' }}
                </td>
                <td class="py-2 pr-4">
                  <span class="px-2 py-0.5 text-xs font-medium border rounded" :class="buildStatusClass(build.status)">{{ build.status }}</span>
                  <p v-if="build.last_error" class="mt-1 text-xs text-red-600 dark:text-red-300 break-words">
                    {{ build.last_error }}
                  </p>
                </td>
                <td class="py-2 pr-4 text-slate-500 whitespace-nowrap">
                  {{ new Date(build.created_at).toLocaleString() }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
