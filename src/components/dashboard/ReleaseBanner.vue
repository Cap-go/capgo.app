<script setup lang="ts">
import type { ReleaseLiveDeployment, ReleaseLiveRollout } from '~/composables/useReleaseLive'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconTrendingUp from '~icons/lucide/trending-up'
import { formatDistanceToNow } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

// Fed by the overview's release_live data so the banner, the KPI tile and the
// Releases tab all show the same release and the same adoption: devices on the
// release's channel that run it, not a share of every active device.
const props = defineProps<{
  appId: string
  release: ReleaseLiveDeployment | null
  adoptionPercent: number | null
  // Set when the release is a progressive rollout target.
  rollout?: ReleaseLiveRollout | null
}>()

const router = useRouter()
const { t } = useI18n()

const RECENT_RELEASE_MS = 48 * 60 * 60 * 1000

const lastReleaseDisplay = computed(() => {
  if (!props.release)
    return t('never')
  return formatDistanceToNow(new Date(props.release.deployed_at))
})

const adoptionPercentLabel = computed(() => {
  if (props.adoptionPercent === null)
    return ''
  return `${formatNumberValue(props.adoptionPercent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
})

const hasRecentRelease = computed(() => {
  if (!props.release)
    return false
  // A running rollout is the release in flight, however old its upload is.
  if (props.rollout?.status === 'running')
    return true
  return Date.now() - Date.parse(props.release.deployed_at) <= RECENT_RELEASE_MS
})

function viewLive() {
  if (!props.release)
    return
  router.push({
    path: `/app/${encodeURIComponent(props.appId)}`,
    query: {
      version: props.release.version_name,
      ...(props.release.channel_id ? { channel: String(props.release.channel_id) } : {}),
    },
  })
}
</script>

<template>
  <button
    v-if="hasRecentRelease"
    type="button"
    data-test="release-banner"
    class="flex items-center justify-between w-full gap-3 px-4 py-2 mb-4 text-left transition-colors border rounded-lg cursor-pointer min-h-11 border-emerald-200 bg-emerald-50 hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-emerald-900/20 dark:border-emerald-800 dark:hover:bg-emerald-900/30"
    @click="viewLive"
  >
    <span class="flex items-center min-w-0 gap-3">
      <IconCheckCircle class="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span class="min-w-0 text-sm">
        <template v-if="rollout">
          <span class="font-semibold text-emerald-900 dark:text-emerald-100">{{ t('release-banner-rollout-title') }}</span>
          <span class="text-emerald-700 dark:text-emerald-300">
            · {{ t('release-banner-rollout', { version: release?.version_name, channel: release?.channel_name ?? '', percent: `${formatNumberValue(rollout.percentage, { maximumFractionDigits: 2 })}%` }) }}<template v-if="rollout.reach_percent !== null"> · {{ t('release-banner-rollout-reach', { percent: `${formatNumberValue(rollout.reach_percent, { maximumFractionDigits: 1 })}%` }) }}</template>
          </span>
        </template>
        <template v-else>
          <span class="font-semibold text-emerald-900 dark:text-emerald-100">{{ t('new-release-available') }}</span>
          <span class="text-emerald-700 dark:text-emerald-300">
            · {{ t('version') }} {{ release?.version_name }}<template v-if="release?.channel_name"> ({{ release.channel_name }})</template> — {{ t('released') }} {{ lastReleaseDisplay }}<template v-if="adoptionPercentLabel"> · {{ t('release-banner-adoption', { percent: adoptionPercentLabel }) }}</template>
          </span>
        </template>
      </span>
    </span>
    <!-- Visual affordance only: the whole banner is the button, so this is a span. -->
    <span
      data-test="release-banner-view"
      class="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium text-white rounded-md shrink-0 bg-emerald-600"
    >
      <IconTrendingUp class="w-4 h-4" />
      {{ t('release-banner-watch-live') }}
    </span>
  </button>
</template>
