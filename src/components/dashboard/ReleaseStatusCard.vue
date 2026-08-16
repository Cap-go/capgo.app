<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconPackage from '~icons/lucide/package'
import IconTrendingUp from '~icons/lucide/trending-up'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import { formatDistanceToNow } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps({
  appId: {
    type: String,
    default: '',
  },
})

const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()

const isLoading = ref(true)
const lastVersion = ref<string>('')
const lastReleaseDate = ref<string | null>(null)
const defaultChannelId = ref<number | null>(null)
const daysSinceRelease = ref<number | null>(null)

const HOURS_48_IN_DAYS = 2

const status = computed(() => {
  if (isLoading.value)
    return 'loading'
  if (!lastReleaseDate.value)
    return 'empty'
  if (daysSinceRelease.value === null || daysSinceRelease.value > HOURS_48_IN_DAYS)
    return 'old'
  return 'recent'
})

const lastReleaseDisplay = computed(() => {
  if (!lastReleaseDate.value)
    return t('never')
  return formatDistanceToNow(new Date(lastReleaseDate.value))
})

const hasData = computed(() => {
  return !!lastReleaseDate.value
})

// Use version name as the "total" display
const effectiveTotal = computed(() => {
  if (!lastVersion.value)
    return 0
  // Return 1 to indicate we have data, the actual display will be the version name
  return 1
})

const statusTitle = computed(() => {
  switch (status.value) {
    case 'loading':
      return t('checking-releases')
    case 'empty':
      return t('no-releases-yet')
    case 'recent':
      return t('recent-releases-active')
    case 'old':
      return t('no-recent-releases')
    default:
      return ''
  }
})

async function calculateStats() {
  if (!props.appId) {
    isLoading.value = false
    return
  }

  try {
    isLoading.value = true
    await organizationStore.awaitInitialLoad()
    const orgId = organizationStore.currentOrganization?.gid

    if (!orgId) {
      lastVersion.value = ''
      lastReleaseDate.value = null
      defaultChannelId.value = null
      daysSinceRelease.value = null
      return
    }

    // Fetch latest version for this app
    const { data: versionsData, error: versionsError } = await supabase
      .from('app_versions')
      .select('name, created_at')
      .eq('app_id', props.appId)
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)

    if (versionsError) {
      console.error('Error fetching versions:', versionsError)
    }

    // Fetch default channel (public channel) for this app
    const { data: channelsData, error: channelsError } = await supabase
      .from('channels')
      .select('id, public')
      .eq('app_id', props.appId)
      .eq('public', true)
      .limit(1)

    if (channelsError) {
      console.error('Error fetching channels:', channelsError)
    }

    const latestVersion = versionsData?.[0]
    const defaultChannel = channelsData?.[0]

    if (latestVersion) {
      lastVersion.value = latestVersion.name
      lastReleaseDate.value = latestVersion.created_at

      const releaseDate = new Date(latestVersion.created_at ?? '')
      const now = new Date()
      daysSinceRelease.value = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24)
    }
    else {
      lastVersion.value = ''
      lastReleaseDate.value = null
      daysSinceRelease.value = null
    }

    defaultChannelId.value = defaultChannel?.id || null
  }
  catch (error) {
    console.error('Error in calculateStats:', error)
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

// Watch for organization changes
watch(() => organizationStore.currentOrganization?.gid, async (newOrgId, oldOrgId) => {
  if (newOrgId && oldOrgId && newOrgId !== oldOrgId) {
    await calculateStats()
  }
})

// Watch for appId changes
watch(() => props.appId, async (newAppId) => {
  if (newAppId) {
    await calculateStats()
  }
})

onMounted(async () => {
  await calculateStats()
})
</script>

<template>
  <ChartCard
    :title="t('active-bundle')"
    :total="effectiveTotal"
    :is-loading="isLoading"
    :has-data="hasData"
    :no-data-message="t('no-releases-yet')"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <h2 class="flex-1 min-w-0 text-2xl font-semibold leading-tight dark:text-white text-slate-600">
          {{ t('active-bundle') }}
        </h2>
      </div>
    </template>

    <!-- Custom total display with version name -->
    <template v-if="hasData" #default>
      <div class="flex flex-col h-full">
        <!-- Version display as main metric -->
        <div
          class="flex items-center gap-3 p-4 mb-4 border rounded-lg"
          :class="{
            'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800': status === 'recent',
            'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800': status === 'old',
          }"
        >
          <div
            class="flex items-center justify-center w-12 h-12 rounded-full"
            :class="{
              'bg-emerald-100 dark:bg-emerald-900/50': status === 'recent',
              'bg-amber-100 dark:bg-amber-900/50': status === 'old',
            }"
          >
            <IconPackage
              class="w-6 h-6"
              :class="{
                'text-emerald-600 dark:text-emerald-400': status === 'recent',
                'text-amber-600 dark:text-amber-400': status === 'old',
              }"
            />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm text-slate-600 dark:text-slate-400">
              {{ t('version') }}
            </p>
            <p class="text-xl font-bold truncate text-slate-900 dark:text-white">
              {{ lastVersion }}
            </p>
          </div>
        </div>

        <!-- Release info -->
        <div class="px-2 mb-4">
          <div class="flex items-center justify-between">
            <span class="text-sm text-slate-600 dark:text-slate-400">
              {{ t('released') }}
            </span>
            <span
              class="text-sm font-medium"
              :class="{
                'text-emerald-600 dark:text-emerald-400': status === 'recent',
                'text-amber-600 dark:text-amber-400': status === 'old',
              }"
            >
              {{ lastReleaseDisplay }}
            </span>
          </div>
          <div class="flex items-center justify-between mt-2">
            <span class="text-sm text-slate-600 dark:text-slate-400">
              {{ t('status') }}
            </span>
            <span
              class="text-sm font-medium"
              :class="{
                'text-emerald-600 dark:text-emerald-400': status === 'recent',
                'text-amber-600 dark:text-amber-400': status === 'old',
              }"
            >
              {{ statusTitle }}
            </span>
          </div>
        </div>

        <!-- Action button -->
        <button
          type="button"
          v-if="defaultChannelId"
          class="flex items-center justify-center w-full gap-2 px-4 py-2 mt-auto text-sm font-medium text-white transition-colors rounded-md"
          :class="{
            'bg-emerald-600 hover:bg-emerald-700': status === 'recent',
            'bg-amber-600 hover:bg-amber-700': status === 'old',
          }"
          @click="viewStats"
        >
          <IconTrendingUp class="w-4 h-4" />
          {{ t('view-stats') }}
        </button>
      </div>
    </template>
  </ChartCard>
</template>
