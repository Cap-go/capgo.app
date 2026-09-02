<script setup lang="ts">
import type { PluginDistTags, PluginVersionStatus } from '~/services/pluginVersionRecommendation'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import IconActivity from '~icons/lucide/activity'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconClipboard from '~icons/lucide/clipboard'
import IconExternalLink from '~icons/lucide/external-link'
import IconLayers from '~icons/lucide/layers'
import IconRocket from '~icons/lucide/rocket'
import IconSmartphone from '~icons/lucide/smartphone'
import { useNativeObserveStats } from '~/composables/useNativeObserveStats'
import { formatNumberValue } from '~/services/formatLocale'
import {
  buildPluginVersionRecommendation,
  fetchUpdaterDistTags,
  UPDATER_INSTALL_DOCS_URL,
} from '~/services/pluginVersionRecommendation'
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
const distTags = ref<PluginDistTags | null>(null)

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
const recommendation = computed(() => {
  if (statsLoading.value)
    return null
  return buildPluginVersionRecommendation(pluginVersions.value, distTags.value)
})
const recommendationRows = computed(() => recommendation.value?.rows ?? pluginVersions.value.map(version => ({
  ...version,
  major: null,
  latestForMajor: null,
  status: 'unknown' as const,
})))
const behindDevicesDisplay = computed(() => {
  if (!recommendation.value?.statusResolved)
    return null
  return recommendation.value.behindDevices
})

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

function statusLabel(status: PluginVersionStatus) {
  if (status === 'behind')
    return t('native-observe-plugin-status-behind')
  if (status === 'current')
    return t('native-observe-plugin-status-current')
  if (status === 'unsupported')
    return t('native-observe-plugin-status-unsupported')
  return t('native-observe-plugin-status-unknown')
}

function statusBadgeClass(status: PluginVersionStatus) {
  if (status === 'behind')
    return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/70 dark:bg-amber-900/20 dark:text-amber-200'
  if (status === 'current')
    return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/70 dark:bg-emerald-900/20 dark:text-emerald-200'
  if (status === 'unsupported')
    return 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700/70 dark:bg-rose-900/20 dark:text-rose-200'
  return 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300'
}

async function copyInstallCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command)
    toast.success(t('copied-to-clipboard'))
  }
  catch (error) {
    console.error('Failed to copy:', error)
    toast.error(t('cannot-copy'))
  }
}

watch(packageId, async () => {
  displayStore.NavTitle = t('observe')
  displayStore.defaultBack = '/apps'
  const [, tags] = await Promise.all([
    fetchPluginStats(),
    fetchUpdaterDistTags(),
  ])
  distTags.value = tags
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
        <section
          v-if="recommendation && (recommendation.unsupported || recommendation.recommendedVersion)"
          data-test="observe-plugin-upgrade"
          class="p-4 border rounded-lg shadow-sm"
          :class="recommendation.needsUpdate
            ? 'border-amber-200 bg-amber-50/80 dark:border-amber-800/70 dark:bg-amber-950/20'
            : 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-800/70 dark:bg-emerald-950/20'"
        >
          <div class="flex items-start gap-3">
            <IconAlertTriangle
              v-if="recommendation.needsUpdate"
              class="w-5 h-5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-300"
              aria-hidden="true"
            />
            <IconCheckCircle
              v-else
              class="w-5 h-5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-300"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-semibold text-slate-950 dark:text-white">
                {{ t('native-observe-plugin-upgrade-title') }}
              </h2>
              <p class="mt-1 text-sm text-slate-700 dark:text-slate-200">
                <template v-if="recommendation.unsupported">
                  {{ t('native-observe-plugin-upgrade-unsupported', { current: recommendation.dominantVersion }) }}
                </template>
                <template v-else-if="recommendation.needsUpdate && recommendation.recommendedVersion && recommendation.dominantMajor !== null">
                  {{ t('native-observe-plugin-upgrade-needed', {
                    current: recommendation.dominantVersion,
                    major: recommendation.dominantMajor,
                    latest: recommendation.recommendedVersion,
                  }) }}
                </template>
                <template v-else-if="recommendation.recommendedVersion && recommendation.dominantMajor !== null">
                  {{ t('native-observe-plugin-upgrade-current', {
                    major: recommendation.dominantMajor,
                    latest: recommendation.recommendedVersion,
                  }) }}
                </template>
              </p>
              <p v-if="recommendation.behindDevices > 0" class="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {{ t('native-observe-plugin-behind-stats', {
                  count: formatCount(recommendation.behindDevices),
                  share: formatPercent(recommendation.behindShare),
                }, recommendation.behindDevices) }}
              </p>
              <div v-if="recommendation.installCommand" class="flex flex-col gap-2 mt-3 sm:flex-row sm:items-center">
                <code class="min-w-0 flex-1 px-3 py-2 text-sm break-all rounded-md bg-white/80 text-slate-800 dark:bg-slate-900/70 dark:text-slate-100">{{ recommendation.installCommand }}</code>
                <button
                  class="d-btn d-btn-sm d-btn-primary shrink-0"
                  type="button"
                  :aria-label="t('copy-command')"
                  @click="copyInstallCommand(recommendation.installCommand)"
                >
                  <IconClipboard class="w-4 h-4" aria-hidden="true" />
                  {{ t('copy') }}
                </button>
              </div>
              <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {{ t('native-observe-plugin-install-help') }}
              </p>
              <a
                :href="UPDATER_INSTALL_DOCS_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 mt-2 text-sm font-medium text-azure-700 hover:underline dark:text-azure-300"
              >
                {{ t('native-observe-plugin-docs') }}
                <IconExternalLink class="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

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
                {{ t('native-observe-plugin-latest-for-major') }}
              </div>
              <div class="mt-2 text-2xl font-semibold break-words text-slate-950 dark:text-white">
                {{ recommendation?.recommendedVersion ?? '-' }}
              </div>
            </div>

            <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <IconActivity class="w-4 h-4" aria-hidden="true" />
                {{ t('native-observe-plugin-devices-behind') }}
              </div>
              <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
                {{ behindDevicesDisplay === null ? '-' : formatCount(behindDevicesDisplay) }}
              </div>
            </div>
          </div>

          <div
            v-if="recommendation?.majors.length"
            data-test="observe-plugin-majors"
            class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700"
          >
            <h3 class="text-sm font-semibold text-slate-950 dark:text-white">
              {{ t('native-observe-plugin-majors') }}
            </h3>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {{ t('native-observe-plugin-majors-help') }}
            </p>
            <div class="mt-3 overflow-x-auto">
              <table class="w-full min-w-[640px] text-sm">
                <thead class="text-xs uppercase text-slate-500 dark:text-slate-400">
                  <tr>
                    <th class="px-0 py-2 font-medium text-left whitespace-nowrap">
                      {{ t('native-observe-plugin-capacitor-major') }}
                    </th>
                    <th class="px-3 py-2 font-medium text-left whitespace-nowrap">
                      {{ t('native-observe-plugin-latest-for-major') }}
                    </th>
                    <th class="px-3 py-2 font-medium text-right whitespace-nowrap">
                      {{ t('devices') }}
                    </th>
                    <th class="px-3 py-2 font-medium text-right whitespace-nowrap">
                      {{ t('native-observe-plugin-devices-behind') }}
                    </th>
                    <th class="px-0 py-2 font-medium text-right whitespace-nowrap">
                      {{ t('native-observe-plugin-fleet-share') }}
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
                  <tr v-for="major in recommendation.majors" :key="major.major">
                    <td class="px-0 py-3 font-medium text-slate-900 dark:text-slate-100">
                      {{ major.major }}
                    </td>
                    <td class="px-3 py-3 text-slate-600 dark:text-slate-300">
                      <div class="flex flex-col gap-0.5">
                        <span>{{ major.latestVersion ?? '-' }}</span>
                        <span v-if="major.installPackage" class="text-xs text-slate-400 dark:text-slate-500">{{ major.installPackage }}</span>
                      </div>
                    </td>
                    <td class="px-3 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {{ formatCount(major.devices) }}
                    </td>
                    <td class="px-3 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {{ major.statusResolved ? formatCount(major.behindDevices) : '-' }}
                    </td>
                    <td class="px-0 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {{ formatPercent(major.share) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div v-if="recommendationRows.length" class="overflow-x-auto">
              <table class="w-full min-w-[720px] text-sm">
                <thead class="text-xs uppercase text-slate-500 dark:text-slate-400">
                  <tr>
                    <th class="px-0 py-2 font-medium text-left whitespace-nowrap">
                      {{ t('native-observe-plugin-version') }}
                    </th>
                    <th class="px-3 py-2 font-medium text-left whitespace-nowrap">
                      {{ t('native-observe-plugin-latest-for-major') }}
                    </th>
                    <th class="px-3 py-2 font-medium text-left whitespace-nowrap">
                      {{ t('status') }}
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
                  <tr v-for="version in recommendationRows" :key="version.plugin_version">
                    <td class="px-0 py-3 font-medium break-all text-slate-900 dark:text-slate-100">
                      <div class="flex items-center gap-2">
                        <span>{{ version.plugin_version }}</span>
                        <span v-if="version.plugin_version === dominantPluginVersion?.plugin_version" class="d-badge d-badge-sm d-badge-ghost">
                          {{ t('native-observe-plugin-most-reported') }}
                        </span>
                      </div>
                    </td>
                    <td class="px-3 py-3 text-slate-600 dark:text-slate-300">
                      {{ version.latestForMajor ?? '-' }}
                    </td>
                    <td class="px-3 py-3">
                      <span class="inline-flex px-2 py-0.5 text-[11px] font-medium rounded-full border" :class="statusBadgeClass(version.status)">
                        {{ statusLabel(version.status) }}
                      </span>
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
