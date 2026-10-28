<script setup lang="ts">
import type { BundleSummaryRow } from '~/services/bundleColumns'
import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { BUNDLE_SUMMARY_COLUMNS } from '~/services/bundleColumns'
import { useConsole } from '~/services/console'
import { useDisplayStore } from '~/stores/display'

const route = useRoute('/app/[app].bundle.[bundle].history')
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()
const capgo = useConsole()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const version = ref<BundleSummaryRow>()

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

watchEffect(async () => {
  if (route.path.includes('/bundle/') && route.path.includes('/history')) {
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.bundle as string)
    await getVersion()
    loading.value = false
    if (!version.value?.name)
      displayStore.NavTitle = t('bundle')
    displayStore.defaultBack = `/app/${route.params.app}/bundles`
  }
})
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="version">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-sm md:rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10">
          <HistoryTable
            :bundle-id="id"
            :app-id="version.app_id"
          />
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-red-500" />
      <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
        {{ t('bundle-not-found') }}
      </h2>
      <p class="mt-2 text-slate-600 dark:text-slate-400">
        {{ t('bundle-not-found-description') }}
      </p>
      <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/bundles`)">
        {{ t('back-to-bundles') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
