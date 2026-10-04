<script setup lang="ts">
import type { ReleaseLiveDeployment } from '~/composables/useReleaseLive'
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
  return Date.now() - Date.parse(props.release.deployed_at) <= RECENT_RELEASE_MS
})

function viewLive() {
  if (!props.release)
    return
  router.push({
    path: `/app/${encodeURIComponent(props.appId)}/observe/releases`,
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
    class="block w-full mb-4 overflow-hidden text-left transition-colors border rounded-lg cursor-pointer border-emerald-200 bg-emerald-50 hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-emerald-900/20 dark:border-emerald-800 dark:hover:bg-emerald-900/30"
    @click="viewLive"
  >
    <div class="flex items-center justify-between p-4">
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center flex-shrink-0 w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/50">
          <IconCheckCircle class="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
        </div>

        <div class="flex items-center gap-4">
          <div>
            <p class="font-semibold text-emerald-900 dark:text-emerald-100">
              {{ t('new-release-available') }}
            </p>
            <p class="text-sm text-emerald-700 dark:text-emerald-300">
              {{ t('version') }} {{ release?.version_name }}<template v-if="release?.channel_name">
                ({{ release.channel_name }})
              </template> — {{ t('released') }} {{ lastReleaseDisplay }}
              <template v-if="adoptionPercentLabel">
                · {{ t('release-banner-adoption', { percent: adoptionPercentLabel }) }}
              </template>
            </p>
          </div>
        </div>
      </div>

      <!-- Visual affordance only: the whole card is the button, so this is a span. -->
      <span
        data-test="release-banner-view"
        class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-md bg-emerald-600 shrink-0"
      >
        <IconTrendingUp class="w-4 h-4" />
        {{ t('release-banner-watch-live') }}
      </span>
    </div>
  </button>
</template>
