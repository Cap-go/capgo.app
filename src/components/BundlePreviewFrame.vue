<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconExternalLink from '~icons/lucide/external-link'
import IconInfo from '~icons/lucide/info'
import IconPlay from '~icons/lucide/play'
import IconSmartphone from '~icons/lucide/smartphone'
import { buildBundlePreviewDeepLink, buildChannelPreviewDeepLink } from '~/services/previewLinks'
import { routePreviewScan } from '~/services/previewNavigation'
import { buildPreviewQrCodeDataUrl } from '~/services/previewQrCode'
import { buildChannelPreviewSubdomain, buildPreviewSubdomain } from '../../shared/preview-subdomain.ts'

const props = withDefaults(defineProps<{
  appId: string
  versionId?: number
  channelId?: number
  channelName?: string
  browserPreview?: boolean
  browserPreviewUnavailableReason?: 'missing-manifest' | 'encrypted' | null
  nativeStylePreview?: boolean
}>(), {
  browserPreview: true,
  browserPreviewUnavailableReason: null,
  nativeStylePreview: false,
})

const { t } = useI18n()
const router = useRouter()
const isNativePlatform = Capacitor.isNativePlatform()

// Device configurations
const devices = {
  iphone: {
    name: 'iPhone',
    width: 375,
    height: 812,
    frameClass: 'rounded-[40px]',
    screenClass: 'rounded-[28px] [clip-path:inset(0_round_28px)]',
  },
  pixel: {
    name: 'Google Pixel',
    width: 412,
    height: 915,
    frameClass: 'rounded-[30px]',
    screenClass: 'rounded-[18px] [clip-path:inset(0_round_18px)]',
  },
}

type DeviceType = keyof typeof devices
const selectedDevice = ref<DeviceType>('iphone')
const qrCodeDataUrl = ref('')
const isMobile = ref(false)

onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
  generateQRCode()
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
})

function checkMobile() {
  isMobile.value = window.innerWidth < 768
}

const currentDevice = computed(() => devices[selectedDevice.value])
const isEncryptedPreview = computed(() => props.browserPreviewUnavailableReason === 'encrypted')
const showBrowserPreview = computed(() => props.browserPreview && !isEncryptedPreview.value)
const showNativeStylePreview = computed(() => isNativePlatform || isMobile.value || props.nativeStylePreview)
const showQrCode = computed(() => !!qrCodeDataUrl.value && !isEncryptedPreview.value && (!isMobile.value || !showBrowserPreview.value))
const browserPreviewHelp = computed(() => {
  if (props.browserPreviewUnavailableReason === 'missing-manifest') {
    return {
      title: t('web-preview-needs-manifest'),
      description: t('web-preview-needs-manifest-description'),
      command: 'npx @capgo/cli@latest bundle upload --delta',
    }
  }

  if (props.browserPreviewUnavailableReason === 'encrypted') {
    return {
      title: t('web-preview-encrypted-unavailable'),
      description: t('web-preview-encrypted-unavailable-description'),
      command: '',
    }
  }

  return null
})

// Build the preview URL using a reversible preview subdomain format.
const previewUrl = computed<string | null>(() => {
  try {
    const hasVersionId = typeof props.versionId === 'number'
    const hasChannelId = typeof props.channelId === 'number'

    if (hasVersionId === hasChannelId) {
      console.error('BundlePreviewFrame requires exactly one preview target')
      return null
    }

    const subdomain = hasChannelId
      ? buildChannelPreviewSubdomain(props.appId, props.channelId as number)
      : buildPreviewSubdomain(props.appId, props.versionId as number)
    // Extract base domain from current host, default to capgo.app for localhost
    // Preserve environment segments (e.g., 'dev' in console.dev.capgo.app)
    const hostname = globalThis.location.hostname
    let baseDomain = 'capgo.app'
    if (hostname.includes('.') && hostname !== '127.0.0.1') {
      const hostParts = hostname.split('.')
      // Check if hostname contains an env segment (dev, preprod, staging, etc.)
      const envSegments = ['dev', 'preprod', 'staging']
      const hasEnvSegment = hostParts.length > 2 && envSegments.some(env => hostParts.includes(env))
      baseDomain = hasEnvSegment ? hostParts.slice(-3).join('.') : hostParts.slice(-2).join('.')
    }
    return `https://${subdomain}.preview.${baseDomain}/`
  }
  catch (error) {
    console.error('Failed to build preview URL:', error)
    return null
  }
})

const qrCodeUrl = computed<string | null>(() => {
  if (!previewUrl.value)
    return null

  if (typeof props.channelId === 'number' && props.channelName) {
    return buildChannelPreviewDeepLink({
      appId: props.appId,
      channelId: props.channelId,
      channelName: props.channelName,
      origin: globalThis.location.origin,
    })
  }

  if (typeof props.versionId === 'number') {
    return buildBundlePreviewDeepLink({
      appId: props.appId,
      origin: globalThis.location.origin,
      versionId: props.versionId,
    })
  }

  return previewUrl.value
})
const startPreviewDisabled = computed(() => {
  if (isEncryptedPreview.value)
    return true
  if (isNativePlatform)
    return !qrCodeUrl.value
  return !previewUrl.value || !!browserPreviewHelp.value
})
// Generate QR code linking to the preview URL
function generateQRCode() {
  if (!qrCodeUrl.value || isEncryptedPreview.value) {
    qrCodeDataUrl.value = ''
    return
  }

  try {
    qrCodeDataUrl.value = buildPreviewQrCodeDataUrl(qrCodeUrl.value)
  }
  catch (error) {
    console.error('Failed to generate QR code:', error)
  }
}

// Watch for URL/encryption changes to regenerate QR
watch([qrCodeUrl, isEncryptedPreview], generateQRCode)

function openExternal() {
  if (!previewUrl.value)
    return
  window.open(previewUrl.value, '_blank')
}

async function startNativePreview() {
  if (!qrCodeUrl.value)
    return

  await routePreviewScan(router, qrCodeUrl.value)
}

async function startPreview() {
  if (startPreviewDisabled.value)
    return

  if (isNativePlatform) {
    await startNativePreview()
    return
  }

  openExternal()
}
</script>

<template>
  <div
    v-if="showNativeStylePreview"
    class="flex min-h-[calc(100dvh-8rem)] w-full flex-col items-center justify-center gap-5 px-4 py-6"
  >
    <button
      class="inline-flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-blue-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
      :disabled="startPreviewDisabled"
      @click="startPreview"
    >
      <IconPlay class="h-5 w-5" />
      {{ t('start-preview') }}
    </button>

    <div
      v-if="qrCodeDataUrl"
      class="flex w-full max-w-xs flex-col items-center rounded-xl bg-white p-5 shadow-lg dark:bg-gray-800"
    >
      <img
        :src="qrCodeDataUrl"
        :alt="t('qr-code-preview-alt')"
        class="mb-3 h-44 w-44"
      >
      <p class="max-w-40 text-center text-sm text-gray-600 dark:text-gray-400">
        {{ t('scan-qr-to-preview') }}
      </p>
    </div>

    <div
      v-if="browserPreviewHelp && (!isNativePlatform || isEncryptedPreview)"
      class="w-full max-w-xs rounded-lg border border-blue-100 bg-blue-50 p-3 text-left dark:border-blue-500/30 dark:bg-blue-500/10"
    >
      <div class="flex items-start gap-2">
        <IconInfo class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-blue-950 dark:text-blue-100">
            {{ browserPreviewHelp.title }}
          </p>
          <p class="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-100/80">
            {{ browserPreviewHelp.description }}
          </p>
          <code
            v-if="browserPreviewHelp.command"
            class="mt-2 block overflow-x-auto rounded-md bg-white px-2 py-1.5 text-[11px] text-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            {{ browserPreviewHelp.command }}
          </code>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="relative min-h-[calc(100dvh-8rem)] w-full overflow-y-auto px-3 py-4 md:px-6 md:py-6">
    <button
      v-if="showBrowserPreview"
      class="absolute z-10 p-2 transition-colors bg-white rounded-lg shadow-lg top-4 right-4 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700"
      :title="t('open-in-external')"
      :disabled="!previewUrl"
      @click="openExternal"
    >
      <IconExternalLink class="w-5 h-5" />
    </button>

    <div
      class="min-h-full gap-5"
      :class="showBrowserPreview
        ? 'grid items-start lg:grid-cols-[minmax(0,1fr)_16rem]'
        : 'flex items-center justify-center'"
    >
      <div v-if="showBrowserPreview" class="flex min-w-0 flex-col items-center">
        <div class="flex items-center gap-2 mb-4">
          <button
            class="flex items-center gap-2 px-3 py-2 text-sm transition-colors border rounded-lg"
            :class="selectedDevice === 'iphone'
              ? 'bg-blue-500 text-white border-blue-500'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'"
            @click="selectedDevice = 'iphone'"
          >
            <IconSmartphone class="w-4 h-4" />
            {{ t('device-iphone') }}
          </button>
          <button
            class="flex items-center gap-2 px-3 py-2 text-sm transition-colors border rounded-lg"
            :class="selectedDevice === 'pixel'
              ? 'bg-blue-500 text-white border-blue-500'
              : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'"
            @click="selectedDevice = 'pixel'"
          >
            <IconSmartphone class="w-4 h-4" />
            {{ t('device-pixel') }}
          </button>
        </div>

        <div
          class="relative max-w-full p-3 bg-gray-900 shadow-2xl"
          :class="currentDevice.frameClass"
          :style="{
            width: `${currentDevice.width + 24}px`,
            height: `min(${Math.min(currentDevice.height + 24, 700)}px, calc(100dvh - 13rem))`,
          }"
        >
          <div
            v-if="selectedDevice === 'iphone'"
            class="absolute z-10 w-32 transform -translate-x-1/2 bg-gray-900 top-3 left-1/2 h-7 rounded-b-2xl"
          />

          <div
            class="w-full h-full overflow-hidden bg-white"
            :class="currentDevice.screenClass"
          >
            <iframe
              title="Preview App"
              :src="previewUrl || 'about:blank'"
              class="w-full h-full border-0"
              :style="{
                width: `${currentDevice.width}px`,
                height: '100%',
              }"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone"
            />
          </div>
        </div>
      </div>

      <div
        v-if="showQrCode"
        class="flex w-full flex-col items-center rounded-xl bg-white p-5 shadow-lg dark:bg-gray-800"
        :class="showBrowserPreview ? 'sticky top-4' : 'max-w-sm'"
      >
        <img
          :src="qrCodeDataUrl"
          :alt="t('qr-code-preview-alt')"
          class="mb-3 h-44 w-44"
        >
        <p class="text-sm text-center text-gray-600 dark:text-gray-400 max-w-40">
          {{ t('scan-qr-to-preview') }}
        </p>

        <div
          v-if="browserPreviewHelp"
          class="mt-4 w-full rounded-lg border border-blue-100 bg-blue-50 p-3 text-left dark:border-blue-500/30 dark:bg-blue-500/10"
        >
          <div class="flex items-start gap-2">
            <IconInfo class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
            <div class="min-w-0">
              <p class="text-sm font-semibold text-blue-950 dark:text-blue-100">
                {{ browserPreviewHelp.title }}
              </p>
              <p class="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-100/80">
                {{ browserPreviewHelp.description }}
              </p>
              <code
                v-if="browserPreviewHelp.command"
                class="mt-2 block overflow-x-auto rounded-md bg-white px-2 py-1.5 text-[11px] text-slate-800 dark:bg-slate-950 dark:text-slate-100"
              >
                {{ browserPreviewHelp.command }}
              </code>
            </div>
          </div>
        </div>
      </div>

      <div
        v-else-if="browserPreviewHelp"
        class="w-full max-w-sm rounded-lg border border-blue-100 bg-blue-50 p-3 text-left dark:border-blue-500/30 dark:bg-blue-500/10"
      >
        <div class="flex items-start gap-2">
          <IconInfo class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
          <div class="min-w-0">
            <p class="text-sm font-semibold text-blue-950 dark:text-blue-100">
              {{ browserPreviewHelp.title }}
            </p>
            <p class="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-100/80">
              {{ browserPreviewHelp.description }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
