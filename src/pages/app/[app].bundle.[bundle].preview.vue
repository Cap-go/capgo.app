<script setup lang="ts">
import type { BundleSummaryRow } from '~/services/bundleColumns'
import type { Database } from '~/types/database.types'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconSettings from '~icons/lucide/settings'
import EmptyState from '~/components/EmptyState.vue'
import { BUNDLE_SUMMARY_COLUMNS } from '~/services/bundleColumns'
import { useConsole } from '~/services/console'
import { useDisplayStore } from '~/stores/display'

const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()
const capgo = useConsole()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const version = ref<BundleSummaryRow>()
const app = ref<Database['public']['Tables']['apps']['Row']>()

type PreviewState = 'loading' | 'preview-disabled' | 'ready'
const previewState = ref<PreviewState>('loading')
const browserPreviewUnavailableReason = computed<'missing-manifest' | 'encrypted' | null>(() => {
  const currentVersion = version.value
  if (!currentVersion)
    return null
  // Encryption blocks all Capgo preview paths; check it before missing-manifest.
  if (currentVersion.session_key)
    return 'encrypted'
  if (!currentVersion.manifest_count)
    return 'missing-manifest'
  return null
})
const browserPreviewAvailable = computed(() => {
  const currentVersion = version.value
  return !browserPreviewUnavailableReason.value && !!currentVersion
})

async function getVersion() {
  if (!id.value)
    return

  try {
    const { data, error } = await capgo
      .from('app_versions')
      .select(BUNDLE_SUMMARY_COLUMNS)
      .eq('app_id', packageId.value)
      .eq('id', id.value)
      .single()

    if (error) {
      console.error('no version', error)
      return
    }

    version.value = data

    if (version.value?.name)
      displayStore.setBundleName(String(version.value.id), version.value.name)
    displayStore.NavTitle = version.value?.name ?? t('bundle')
  }
  catch (error) {
    console.error(error)
  }
}

async function getApp() {
  try {
    const { data, error } = await capgo
      .from('apps')
      .select()
      .eq('app_id', packageId.value)
      .single()

    if (error) {
      console.error('no app', error)
      return
    }

    app.value = data
  }
  catch (error) {
    console.error(error)
  }
}

function determinePreviewState() {
  if (!version.value || !app.value) {
    previewState.value = 'loading'
    return
  }

  // Check if preview is disabled for the app
  if (!app.value.allow_preview) {
    previewState.value = 'preview-disabled'
    return
  }

  previewState.value = 'ready'
}

function goToAppSettings() {
  router.push(`/app/${packageId.value}/settings`)
}

watchEffect(async () => {
  // Use route.name for more specific matching instead of path.includes()
  if (route.name === '/app/[app].bundle.[bundle].preview') {
    loading.value = true
    previewState.value = 'loading'
    packageId.value = route.params.app as string
    id.value = Number(route.params.bundle)
    await Promise.all([getVersion(), getApp()])
    determinePreviewState()
    loading.value = false
    displayStore.defaultBack = `/app/${packageId.value}/bundles`
  }
})
</script>

<template>
  <div>
    <!-- Loading State -->
    <PageLoader v-if="loading" />

    <!-- Version Not Found -->
    <EmptyState
      v-else-if="!version"
      :icon="IconAlertCircle"
      icon-class="text-red-500"
      :title="t('bundle-not-found')"
      :description="t('bundle-not-found-description')"
    >
      <template #action>
        <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/bundles`)">
          {{ t('back-to-bundles') }}
        </button>
      </template>
    </EmptyState>

    <!-- Preview Disabled State -->
    <EmptyState
      v-else-if="previewState === 'preview-disabled'"
      :icon="IconSettings"
      :title="t('preview-disabled')"
      :description="t('preview-disabled-description')"
    >
      <template #action>
        <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="goToAppSettings">
          {{ t('preview-enable-settings') }}
        </button>
      </template>
    </EmptyState>

    <!-- Ready State - Show Preview -->
    <div v-else-if="previewState === 'ready'" class="h-full min-h-0 w-full overflow-y-auto">
      <BundlePreviewFrame
        :app-id="packageId"
        :version-id="id"
        :browser-preview="browserPreviewAvailable"
        :browser-preview-unavailable-reason="browserPreviewUnavailableReason"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
