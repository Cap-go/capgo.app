<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconSettings from '~icons/lucide/settings'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

const route = useRoute()
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const version = ref<Database['public']['Tables']['app_versions']['Row']>()
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
    const { data, error } = await supabase
      .from('app_versions')
      .select()
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
    const { data, error } = await supabase
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
  router.push(`/app/${packageId.value}/info`)
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
    <div v-else-if="!version" class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('bundle-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('bundle-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/bundles`)">
        {{ t('back-to-bundles') }}
      </button>
    </div>

    <!-- Preview Disabled State -->
    <div v-else-if="previewState === 'preview-disabled'" class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconSettings class="w-16 h-16 mb-4 text-muted-foreground" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('preview-disabled') }}
      </h2>
      <p class="mt-2 text-center text-muted-foreground max-w-md">
        {{ t('preview-disabled-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="goToAppSettings">
        {{ t('preview-enable-settings') }}
      </button>
    </div>

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
