<script setup lang="ts">
import type { RollingDateRangePreset } from '~/services/dateRange'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconAlertCircle from '~icons/lucide/alert-circle'
import BundleInstallStatsPanel from '~/components/dashboard/BundleInstallStatsPanel.vue'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import ObserveToolbar from '~/components/observe/ObserveToolbar.vue'
import { useObserveAppScope } from '~/composables/useObserveAppScope'
import { useObserveDateRangeQuery } from '~/composables/useObserveDateRangeQuery'
import { formatLocalDateShort } from '~/services/date'
import { DATE_RANGE_PRESET_LABEL_KEYS } from '~/services/dateRange'
import { legacyStatsDaysFromRange } from '~/utils/observePeriodDays'

const { t } = useI18n()

const {
  id,
  app,
  isLoading,
  selectedVersionName,
  bundleNames,
  publicChannels,
  applyVersionFilter,
} = useObserveAppScope()

const { rangeMode, preciseDates, rangeValue, applyRange } = useObserveDateRangeQuery()

const legacyStatsDays = computed(() =>
  legacyStatsDaysFromRange(rangeValue.value.start, rangeValue.value.end),
)

const periodSummaryLabel = computed(() => {
  if (rangeMode.value !== 'custom' && rangeMode.value in DATE_RANGE_PRESET_LABEL_KEYS)
    return t(DATE_RANGE_PRESET_LABEL_KEYS[rangeMode.value as RollingDateRangePreset])
  return t('custom')
})

const periodRangeLabel = computed(() => {
  const { start, end } = rangeValue.value
  return `${formatLocalDateShort(start.toISOString())} - ${formatLocalDateShort(end.toISOString())}`
})
</script>

<template>
  <div>
    <PageLoader v-if="isLoading" />
    <div v-else-if="app" class="w-full h-full px-4 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <div class="flex flex-col gap-6" data-test="observe-view-update">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0">
            <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ t('observe-update-heading') }}
            </h2>
            <p
              class="mt-1 text-sm text-slate-600 dark:text-slate-300"
              data-testid="observe-period-labels"
            >
              {{ periodSummaryLabel }} · {{ periodRangeLabel }}
            </p>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {{ t('observe-updater-update-help') }}
            </p>
          </div>
          <ObserveToolbar
            :bundle-names="bundleNames"
            :selected-version-name="selectedVersionName"
            :precise-dates="preciseDates"
            :range-mode="rangeMode"
            @update:version="applyVersionFilter"
            @apply-range="applyRange"
          />
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2" :class="publicChannels.length ? 'xl:grid-cols-3' : 'xl:grid-cols-1'">
          <BundleAdoptionCard
            v-for="channel in publicChannels"
            :key="channel.id"
            :app-id="id"
            :version-name="channel.versionName"
            :linked-channel-id="channel.id"
          />
        </div>
        <BundleInstallStatsPanel
          :app-id="id"
          :days="legacyStatsDays"
          :version-name="selectedVersionName"
          hide-period-selector
          compact
        />
        <DeliveryLatencyPanel
          :key="`${id}-${legacyStatsDays}-${rangeValue.start.getTime()}`"
          scope="app"
          :app-id="id"
          :days="legacyStatsDays"
          hide-period-selector
        />
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('app-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('app-not-found-description') }}
      </p>
      <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="$router.push(`/apps`)">
        {{ t('back-to-apps') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
