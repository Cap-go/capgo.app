<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconActivity from '~icons/lucide/activity'
import IconLayers from '~icons/lucide/layers'
import IconRocket from '~icons/lucide/rocket'
import IconSmartphone from '~icons/lucide/smartphone'
import { useNativeObserveStats } from '~/composables/useNativeObserveStats'
import { formatNumberValue } from '~/services/formatLocale'
import { useDisplayStore } from '~/stores/display'

interface NativeObservePluginStatsResponse {
  pluginVersions: Array<{
    plugin_version: string
    devices: number
    total_devices: number
  }>
}

const route = useRoute()
const displayStore = useDisplayStore()
const { t } = useI18n()

const packageId = computed(() => {
  const app = (route.params as Record<string, string | string[] | undefined>).app
  return Array.isArray(app) ? app[0] ?? '' : String(app ?? '')
})
const { stats, statsLoading, fetchStats: fetchPluginStats } = useNativeObserveStats<NativeObservePluginStatsResponse>(
  packageId,
  () => ({ view: 'plugins' }),
  'native observe plugin stats',
)
const pluginVersions = computed(() => stats.value?.pluginVersions ?? [])
const pluginFleetDevices = computed(() => pluginVersions.value[0]?.total_devices ?? 0)
const dominantPluginVersion = computed(() => pluginVersions.value[0] ?? null)
const dominantPluginShare = computed(() => pluginVersionShare(dominantPluginVersion.value))
const otherPluginDevices = computed(() => Math.max(0, pluginFleetDevices.value - (dominantPluginVersion.value?.devices ?? 0)))

function formatCount(value: number | null | undefined) {
  return formatNumberValue(Math.round(value ?? 0))
}

function formatPercent(value: number | null | undefined) {
  return `${formatNumberValue(value ?? 0, { maximumFractionDigits: 1 })}%`
}

function pluginVersionShare(version: NativeObservePluginStatsResponse['pluginVersions'][number] | null | undefined) {
  if (!version || version.total_devices <= 0)
    return 0
  return (version.devices / version.total_devices) * 100
}
watch(packageId, () => {
  displayStore.NavTitle = t('observe')
  displayStore.defaultBack = '/apps'
}, { immediate: true })

watch(packageId, async () => {
  await fetchPluginStats()
}, { immediate: true })
</script>

<template>
  <div class="w-full h-full px-4 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
    <div class="flex flex-col gap-6">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-semibold text-slate-950 dark:text-white">
            {{ t('observe') }}
          </h1>
          <span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t('beta') }}</span>
        </div>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('native-observe-plugin-adoption-help') }}
        </p>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('native-observe-plugin-scope') }}
        </p>
      </div>

      <div v-if="statsLoading && !stats" class="flex items-center justify-center h-80">
        <Spinner size="w-12 h-12" />
      </div>

      <template v-else>
        <section data-test="observe-plugin-insights" class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                {{ t('native-observe-plugin-distribution') }}
              </h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('native-observe-plugin-distribution-help') }}
              </p>
            </div>
            <IconRocket class="w-5 h-5 text-violet-500" aria-hidden="true" />
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconSmartphone class="w-4 h-4" aria-hidden="true" />
                {{ t('native-observe-plugin-production-devices') }}
              </div>
              <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
                {{ formatCount(pluginFleetDevices) }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconRocket class="w-4 h-4" aria-hidden="true" />
                {{ t('native-observe-plugin-most-reported') }}
              </div>
              <div class="mt-2 text-2xl font-semibold break-words text-slate-950 dark:text-white">
                {{ dominantPluginVersion?.plugin_version ?? '-' }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconLayers class="w-4 h-4" aria-hidden="true" />
                {{ t('native-observe-plugin-most-reported-share') }}
              </div>
              <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
                {{ formatPercent(dominantPluginShare) }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconActivity class="w-4 h-4" aria-hidden="true" />
                {{ t('native-observe-plugin-other-version-devices') }}
              </div>
              <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
                {{ formatCount(otherPluginDevices) }}
              </div>
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div v-if="pluginVersions.length" class="overflow-x-auto">
              <table class="w-full min-w-[600px] text-sm">
                <thead class="text-xs uppercase text-slate-500 dark:text-slate-400">
                  <tr>
                    <th class="px-0 py-2 font-medium text-left whitespace-nowrap">
                      {{ t('native-observe-plugin-version') }}
                    </th>
                    <th class="px-3 py-2 font-medium text-right whitespace-nowrap">
                      {{ t('devices') }}
                    </th>
                    <th class="px-0 py-2 font-medium text-right whitespace-nowrap">
                      {{ t('native-observe-plugin-fleet-share') }}
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
                  <tr v-for="version in pluginVersions" :key="version.plugin_version">
                    <td class="px-0 py-3 font-medium break-all text-slate-900 dark:text-slate-100">
                      <div class="flex items-center gap-2">
                        <span>{{ version.plugin_version }}</span>
                        <span v-if="version === dominantPluginVersion" class="d-badge d-badge-sm d-badge-ghost">
                          {{ t('native-observe-plugin-most-reported') }}
                        </span>
                      </div>
                    </td>
                    <td class="px-3 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {{ formatCount(version.devices) }}
                    </td>
                    <td class="px-0 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      <div class="flex items-center justify-end gap-3">
                        <div class="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                          <div class="h-full rounded-full bg-azure-500" :style="{ width: `${pluginVersionShare(version)}%` }" />
                        </div>
                        <span class="w-14">{{ formatPercent(pluginVersionShare(version)) }}</span>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="flex flex-col items-center justify-center h-52 text-center text-slate-500 dark:text-slate-400">
              <IconRocket class="w-10 h-10 mb-3" aria-hidden="true" />
              <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
                {{ t('native-observe-no-plugin-data') }}
              </h2>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
