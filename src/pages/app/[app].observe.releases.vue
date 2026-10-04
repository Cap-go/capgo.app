<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BundleAdoptionCard from '~/components/bundle/BundleAdoptionCard.vue'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import BundleInstallStatsPanel from '~/components/dashboard/BundleInstallStatsPanel.vue'
import { provideChartCardCompact } from '~/components/dashboard/chartCardDensity'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
import ReleaseLivePanel from '~/components/dashboard/ReleaseLivePanel.vue'
import { useAppPage } from '~/composables/useAppPage'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { useSupabase } from '~/services/supabase'

// Everything about OTA delivery in one place: the live rollout of the latest
// release, install performance, which bundles devices run, download latency
// and how far each public channel's bundle has reached.
const { t } = useI18n()
const supabase = useSupabase()
const { id, app, isLoading } = useAppPage({ routeName: '/app/[app].observe.releases' })
const { days } = usePeriodDaysQuery()
const publicChannels = ref<{ id: number, name: string, versionName: string }[]>([])

provideChartCardCompact()

async function loadPublicChannels(appId: string) {
  const { data, error } = await supabase
    .from('channels')
    .select('id, name, version:app_versions!channels_version_fkey(id, name)')
    .eq('app_id', appId)
    .eq('public', true)
    .order('id', { ascending: true })
  if (appId !== id.value)
    return
  if (error) {
    console.error(error)
    publicChannels.value = []
    return
  }

  // Two public channels on the same bundle would show the same reach twice.
  const uniqueByVersion = new Map<string, { id: number, name: string, versionName: string }>()
  for (const channel of data ?? []) {
    const version = channel.version as { name?: string } | { name?: string }[] | null | undefined
    const versionName = (Array.isArray(version) ? version[0] : version)?.name
    if (!versionName || uniqueByVersion.has(versionName))
      continue
    uniqueByVersion.set(versionName, { id: channel.id, name: channel.name, versionName })
  }
  publicChannels.value = [...uniqueByVersion.values()]
}

watch(id, (appId) => {
  publicChannels.value = []
  if (appId)
    void loadPublicChannels(appId)
}, { immediate: true })
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <div v-if="id" class="flex flex-col gap-6 px-4 sm:px-0">
      <ReleaseLivePanel :app-id="id" />

      <section v-if="publicChannels.length" class="flex flex-col gap-3" data-testid="observe-bundle-reach">
        <h2 class="text-base font-semibold text-slate-950 dark:text-white">
          {{ t('bundle-adoption') }}
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <BundleAdoptionCard
            v-for="channel in publicChannels"
            :key="channel.id"
            :app-id="id"
            :version-name="channel.versionName"
            :linked-channel-id="channel.id"
          />
        </div>
      </section>

      <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <BundleInstallStatsPanel :app-id="id" :days="days" hide-period-selector compact />
        <DevicesStats
          :app-id="id"
          usage-kind="bundle"
          variant="chart"
          :use-billing-period="false"
          :accumulated="false"
        />
      </div>

      <DeliveryLatencyPanel :key="id" scope="app" :app-id="id" :days="days" hide-period-selector />
    </div>
  </AppPageFrame>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
