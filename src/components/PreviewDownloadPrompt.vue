<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconPlay from '~icons/lucide/play'
import IconSmartphone from '~icons/lucide/smartphone'
import { buildDeferredPreviewInstallReferrerUrl } from '~/services/previewLinks'
import { routePreviewScan } from '~/services/previewNavigation'
import { buildPreviewQrCodeDataUrl } from '~/services/previewQrCode'

const APP_STORE_URL = 'https://apps.apple.com/pt/app/capgo/id1602316563'
const ANDROID_STORE_URL = 'https://play.google.com/store/apps/details?id=ee.forgr.capacitor_go'
const MOBILE_APP_DOWNLOAD_URL = 'https://capgo.app/app_mobile/'

const { t } = useI18n()
const router = useRouter()
const isNativePlatform = Capacitor.isNativePlatform()
const androidStoreUrl = ref(ANDROID_STORE_URL)
const mobileAppDownloadUrl = ref(MOBILE_APP_DOWNLOAD_URL)
const previewUrl = ref('')
const qrCodeDataUrl = ref('')

function buildAndroidStoreUrl(currentPreviewUrl: string) {
  const url = new URL(ANDROID_STORE_URL)
  const deferredPreviewUrl = buildDeferredPreviewInstallReferrerUrl(currentPreviewUrl)
  if (deferredPreviewUrl) {
    const referrer = new URLSearchParams({ capgo_preview: deferredPreviewUrl })
    url.searchParams.set('referrer', referrer.toString())
  }
  return url.toString()
}

function buildMobileAppDownloadUrl(currentPreviewUrl: string) {
  const url = new URL(MOBILE_APP_DOWNLOAD_URL)
  const deferredPreviewUrl = buildDeferredPreviewInstallReferrerUrl(currentPreviewUrl)
  if (deferredPreviewUrl)
    url.searchParams.set('preview', deferredPreviewUrl)
  return url.toString()
}

function generateQRCode(currentPreviewUrl: string) {
  try {
    qrCodeDataUrl.value = buildPreviewQrCodeDataUrl(currentPreviewUrl)
  }
  catch (error) {
    console.error('Failed to generate preview QR code', error)
  }
}

async function openPreview() {
  if (!previewUrl.value)
    return

  await routePreviewScan(router, previewUrl.value)
}

onMounted(() => {
  const currentPreviewUrl = globalThis.location.href
  previewUrl.value = currentPreviewUrl
  androidStoreUrl.value = buildAndroidStoreUrl(currentPreviewUrl)
  mobileAppDownloadUrl.value = buildMobileAppDownloadUrl(currentPreviewUrl)
  generateQRCode(currentPreviewUrl)
})
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 px-6 py-8 text-center text-white">
    <IconSmartphone class="h-14 w-14 text-blue-400" />
    <h1 class="text-xl font-semibold">
      {{ t('preview-download-title') }}
    </h1>
    <p class="max-w-sm text-sm text-slate-300">
      {{ t('preview-download-description') }}
    </p>

    <div
      v-if="qrCodeDataUrl"
      class="flex w-full max-w-xs flex-col items-center rounded-xl bg-white p-5 text-slate-900 shadow-lg"
    >
      <img
        :src="qrCodeDataUrl"
        :alt="t('qr-code-preview-alt')"
        class="mb-3 h-44 w-44"
      >
      <p class="max-w-44 text-sm text-slate-600">
        {{ t('scan-qr-to-preview') }}
      </p>
    </div>

    <button
      v-if="isNativePlatform"
      class="d-btn d-btn-primary min-h-12 w-full max-w-xs gap-2"
      :disabled="!previewUrl"
      type="button"
      @click="openPreview"
    >
      <IconPlay class="h-5 w-5" />
      {{ t('preview-download-open-preview') }}
    </button>

    <template v-else>
      <div class="flex flex-col items-center gap-3 sm:flex-row">
        <a
          :href="androidStoreUrl"
          class="inline-flex transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400"
          rel="noopener noreferrer"
        >
          <img
            :alt="t('preview-download-google-play-alt')"
            class="h-14 w-auto"
            decoding="async"
            loading="eager"
            src="https://capgo.app/play-store-button.webp"
          >
        </a>
        <a
          :href="APP_STORE_URL"
          class="inline-flex transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400"
          rel="noopener noreferrer"
        >
          <img
            :alt="t('preview-download-app-store-alt')"
            class="h-14 w-auto"
            decoding="async"
            loading="eager"
            src="https://capgo.app/app-store-button.webp"
          >
        </a>
      </div>
      <a
        class="text-sm font-medium text-blue-300 underline-offset-4 hover:text-blue-200 hover:underline"
        :href="mobileAppDownloadUrl"
      >
        {{ t('preview-download-more-options') }}
      </a>
    </template>
  </div>
</template>
