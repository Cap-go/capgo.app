<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconCheckCircle from '~icons/lucide/check-circle'
import IconTrendingUp from '~icons/lucide/trending-up'
import { formatDistanceToNow } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  appId: string
}>()

const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()

const isLoading = ref(false)
const lastVersion = ref<string>('')
const lastReleaseDate = ref<string | null>(null)
const defaultChannelId = ref<number | null>(null)

const HOURS_48_IN_DAYS = 2

const lastReleaseDisplay = computed(() => {
  if (!lastReleaseDate.value)
    return t('never')
  return formatDistanceToNow(new Date(lastReleaseDate.value))
})

const hasRecentRelease = computed(() => {
  if (!lastReleaseDate.value || isLoading.value)
    return false
  const releaseDate = new Date(lastReleaseDate.value)
  const now = new Date()
  const daysSinceRelease = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24)
  return daysSinceRelease <= HOURS_48_IN_DAYS
})

async function fetchReleaseInfo() {
  if (!props.appId) {
    return
  }

  isLoading.value = true
  try {
    await organizationStore.awaitInitialLoad()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      lastVersion.value = ''
      lastReleaseDate.value = null
      defaultChannelId.value = null
      return
    }

    const { data: versionsData } = await supabase
      .from('app_versions')
      .select('name, created_at')
      .eq('app_id', props.appId)
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)

    const { data: channelsData } = await supabase
      .from('channels')
      .select('id')
      .eq('app_id', props.appId)
      .eq('public', true)
      .limit(1)

    const latestVersion = versionsData?.[0]
    const defaultChannel = channelsData?.[0]

    if (latestVersion) {
      lastVersion.value = latestVersion.name
      lastReleaseDate.value = latestVersion.created_at
    }
    else {
      lastVersion.value = ''
      lastReleaseDate.value = null
    }

    defaultChannelId.value = defaultChannel?.id || null
  }
  catch (error) {
    console.error('Error fetching release info:', error)
  }
  finally {
    isLoading.value = false
  }
}

function viewStats() {
  if (defaultChannelId.value) {
    router.push(`/app/${props.appId}/channel/${defaultChannelId.value}/statistics`)
  }
  else {
    router.push(`/app/${props.appId}/channels`)
  }
}

watch(() => [props.appId, organizationStore.currentOrganization?.gid], () => {
  fetchReleaseInfo()
}, { immediate: true })
</script>

<template>
  <button
    v-if="hasRecentRelease"
    type="button"
    data-test="release-banner"
    class="block w-full mb-4 overflow-hidden text-left transition-colors border rounded-lg cursor-pointer border-emerald-200 bg-emerald-50 hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:bg-emerald-900/20 dark:border-emerald-800 dark:hover:bg-emerald-900/30"
    @click="viewStats"
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
              {{ t('version') }} {{ lastVersion }} — {{ t('released') }} {{ lastReleaseDisplay }}
            </p>
          </div>
        </div>
      </div>

      <!-- Visual affordance only: the whole card is the button, so this is a span. -->
      <span
        v-if="defaultChannelId"
        data-test="release-banner-view"
        class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-md bg-emerald-600 shrink-0"
      >
        <IconTrendingUp class="w-4 h-4" />
        {{ t('view-adoption') }}
      </span>
    </div>
  </button>
</template>
