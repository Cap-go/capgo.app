<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconEye from '~icons/heroicons/eye'
import { formatDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  appId: string
}>()

const emit = defineEmits<{
  'update:showingSteps': [value: boolean]
}>()

type BuildRequest = Database['public']['Tables']['build_requests']['Row']
type Element = BuildRequest
type Platform = 'ios' | 'android'

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const isMobile = Capacitor.isNativePlatform()
const dialogStore = useDialogV2Store()
const offset = 20
const search = ref('')
const showSteps = ref(false)
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const elements = ref<Element[]>([])
const buildDurations = ref<Record<string, number>>({})
const isLoading = ref(true)
const currentPage = ref(1)
const total = ref(0)
const totalAllBuilds = ref<number | null>(null)
const platformBuildCounts = ref<Record<Platform, number>>({ ios: 0, android: 0 })
const showSetupFlow = computed(() => showSteps.value || totalAllBuilds.value === 0)
const organizationStore = useOrganizationStore()
const filters = ref({})

const currentBuildsNumber = computed(() => {
  return (currentPage.value - 1) * offset
})

function closeSteps() {
  showSteps.value = false
}

function addOne() {
  showSteps.value = true
}

function onboardingDone() {
  showSteps.value = false
  reload()
}

async function countBuildRequests(platform?: Platform): Promise<number | null> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !props.appId)
    return null

  let query = supabase
    .from('build_requests')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)
    .eq('app_id', props.appId)

  if (platform)
    query = query.eq('platform', platform)

  const { count, error } = await query
  if (error) {
    console.error('Error counting build requests:', error)
    return null
  }
  return count ?? 0
}

async function updateOverallBuildsCount(): Promise<void> {
  const [allBuilds, iosBuilds, androidBuilds] = await Promise.all([
    countBuildRequests(),
    countBuildRequests('ios'),
    countBuildRequests('android'),
  ])

  if (allBuilds !== null)
    totalAllBuilds.value = allBuilds

  platformBuildCounts.value = {
    ios: iosBuilds ?? platformBuildCounts.value.ios,
    android: androidBuilds ?? platformBuildCounts.value.android,
  }
}

async function getData() {
  // Don't load if organization isn't ready yet
  if (!organizationStore.currentOrganization) {
    return
  }
  const orgId = organizationStore.currentOrganization.gid

  isLoading.value = true
  try {
    let query = supabase
      .from('build_requests')
      .select('*', { count: 'exact' })
      .eq('app_id', props.appId)
      .order('created_at', { ascending: false })
      .range(currentBuildsNumber.value, currentBuildsNumber.value + offset - 1)

    if (search.value) {
      query = query.or(`platform.ilike.%${search.value}%,status.ilike.%${search.value}%,builder_job_id.ilike.%${search.value}%`)
    }

    const { data, error, count } = await query

    if (error) {
      console.error('Error fetching build requests:', error)
      toast.error(t('error-fetching-builds'))
      return
    }

    const builds = data || []
    await loadBuildDurations(builds, orgId)
    elements.value = builds
    total.value = count || 0
  }
  catch (error) {
    console.error(error)
    toast.error(t('error-fetching-builds'))
  }
  finally {
    isLoading.value = false
  }
}

async function loadBuildDurations(builds: Element[], orgId: string) {
  const jobIds = builds
    .map(build => build.builder_job_id)
    .filter((id): id is string => !!id)

  if (jobIds.length === 0) {
    buildDurations.value = {}
    return
  }

  // Scope to the current org: build_logs.build_id is only unique per
  // (build_id, org_id), so an unscoped lookup could pick up a colliding
  // row from another org the user can read.
  const { data, error } = await supabase
    .from('build_logs')
    .select('build_id, build_time_unit')
    .eq('org_id', orgId)
    .in('build_id', jobIds)

  if (error) {
    console.error('Error fetching build durations:', error)
    buildDurations.value = {}
    toast.error(t('error-fetching-build-durations'))
    return
  }

  const durations: Record<string, number> = {}
  for (const log of data ?? []) {
    if (log.build_id != null && log.build_time_unit != null)
      durations[log.build_id] = log.build_time_unit
  }
  buildDurations.value = durations
}

async function reload() {
  // Don't reload if organization isn't ready yet
  if (!organizationStore.currentOrganization) {
    return
  }

  currentPage.value = 1
  elements.value = []
  try {
    await Promise.all([getData(), updateOverallBuildsCount()])
  }
  catch (error) {
    console.error(error)
    toast.error(t('error-fetching-builds'))
  }
}

function isPlanUpgradeError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase()
  return normalized.includes('concurrent native')
    || normalized.includes('native build concurrency')
    || normalized.includes('/settings/organization/plans')
    || normalized.includes('upgrade plan to continue to build')
}

function showErrorDetails(errorMessage: string | null) {
  if (!errorMessage) {
    toast.error(t('no-error-message'))
    return
  }

  const showUpgrade = isPlanUpgradeError(errorMessage)
  dialogStore.openDialog({
    title: t('build-error-details'),
    size: 'lg',
    buttons: [
      ...(showUpgrade
        ? [{
            text: t('plan-upgrade-v2'),
            id: 'upgrade',
            role: 'primary' as const,
            handler: () => {
              router.push('/settings/organization/plans')
            },
          }]
        : []),
      {
        text: t('close'),
        role: 'cancel',
      },
    ],
  })

  // Wait for dialog to mount, then inject the content
  setTimeout(() => {
    const contentDiv = document.getElementById('dialog-v2-content')
    if (contentDiv) {
      const pre = document.createElement('pre')
      pre.className = 'p-4 overflow-x-auto font-mono text-sm break-words whitespace-pre-wrap bg-gray-100 rounded-md dark:bg-gray-800'
      pre.textContent = errorMessage
      contentDiv.replaceChildren(pre)
    }
  }, 0)
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return 'text-green-600 dark:text-green-400'
    case 'failed':
      return 'text-red-600 dark:text-red-400'
    case 'running':
    case 'in_progress':
      return 'text-blue-600 dark:text-blue-400'
    case 'pending':
      return 'text-yellow-600 dark:text-yellow-400'
    default:
      return 'text-gray-600 dark:text-gray-400'
  }
}

function formatDuration(seconds: number | null | undefined): string {
  const safeSeconds = Math.max(0, Math.floor(seconds ?? 0))
  if (safeSeconds < 60)
    return `${safeSeconds}s`

  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  if (minutes < 60)
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

columns.value = [
  {
    label: t('created-at'),
    key: 'created_at',
    mobile: true,
    class: 'truncate max-w-32',
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.created_at ?? ''),
  },
  {
    label: t('build-mode'),
    key: 'build_mode',
    mobile: true,
    class: 'truncate max-w-32',
    displayFunction: (elem: Element) => {
      const platform = elem.platform || ''
      const mode = elem.build_mode || ''
      return `${platform} ${mode}`.trim() || '-'
    },
  },
  {
    label: t('build-duration'),
    key: 'build_duration',
    class: 'truncate max-w-24',
    displayFunction: (elem: Element) => {
      const jobId = elem.builder_job_id
      const duration = jobId ? buildDurations.value[jobId] : undefined
      return duration != null ? formatDuration(duration) : '—'
    },
  },
  {
    label: t('status'),
    key: 'status',
    mobile: true,
    class: 'truncate max-w-24',
    displayFunction: (elem: Element) => elem.status,
  },
  {
    label: t('error'),
    key: 'last_error',
    mobile: true,
    class: 'max-w-48',
    displayFunction: (elem: Element) => {
      if (!elem.last_error)
        return '-'
      return elem.last_error.length > 50 ? `${elem.last_error.substring(0, 50)}...` : elem.last_error
    },
  },
  {
    label: t('updated-at'),
    key: 'updated_at',
    class: 'truncate max-w-32',
    displayFunction: (elem: Element) => formatDate(elem.updated_at ?? ''),
  },
]

// Watch props change (app switching) - same pattern as BundleTable
watch(props, async () => {
  await reload()
})

// Ensure totalAllBuilds is populated on initial mount so the setup flow
// renders when the org has no builds yet. watch(props, ...) doesn't fire
// for the initial value, and DataTable's @reload hook only calls getData().
onMounted(async () => {
  await organizationStore.awaitInitialLoad()
  await reload()
})

watch(showSetupFlow, (newValue) => {
  emit('update:showingSteps', newValue)
}, { immediate: true })
</script>

<template>
  <div>
    <StepsBuild
      v-if="showSetupFlow"
      :onboarding="(totalAllBuilds ?? 0) === 0"
      :app-id="props.appId"
      :platform-build-counts="platformBuildCounts"
      :can-close="(totalAllBuilds ?? 0) > 0"
      @done="onboardingDone"
      @close-step="closeSteps()"
    />
    <div v-else class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <DataTable
        v-model:filters="filters"
        v-model:search="search"
        v-model:current-page="currentPage"
        :columns="columns"
        :element-list="elements"
        :is-loading="isLoading"
        :search-function="(e: Element, s: string) => e.platform.toLowerCase().includes(s.toLowerCase()) || e.status.toLowerCase().includes(s.toLowerCase())"
        :search-placeholder="t('search-builds')"
        :show-add="!isMobile"
        :total="total"
        :offset="offset"
        @add="addOne()"
        @reset="reload()"
        @reload="getData()"
      >
        <template #status="{ element }">
          <span
            class="font-semibold"
            :class="getStatusColor(element.status)"
          >
            {{ element.status }}
          </span>
        </template>
        <template #last_error="{ element }">
          <div v-if="element.last_error" class="flex items-center gap-2">
            <span class="max-w-xs text-red-600 truncate dark:text-red-400">
              {{ element.last_error.length > 50 ? `${element.last_error.substring(0, 50)}...` : element.last_error }}
            </span>
            <button
              class="p-1 text-gray-500 rounded-md cursor-pointer shrink-0 dark:text-gray-400 hover:text-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700 dark:hover:text-gray-300"
              @click.stop="showErrorDetails(element.last_error)"
            >
              <IconEye class="w-4 h-4" />
            </button>
            <button
              v-if="isPlanUpgradeError(element.last_error)"
              type="button"
              class="px-2 py-1 text-xs font-semibold text-white rounded-md d-btn d-btn-xs d-btn-primary shrink-0"
              @click.stop="router.push('/settings/organization/plans')"
            >
              {{ t('plan-upgrade-v2') }}
            </button>
          </div>
          <span v-else class="text-gray-400 dark:text-gray-600">-</span>
        </template>
        <template #empty>
          <div class="flex flex-col items-center justify-center p-8">
            <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
              {{ t('no-builds-yet') }}
            </h3>
            <p class="max-w-md text-center text-gray-600 dark:text-gray-400">
              {{ t('no-builds-description') }}
            </p>
          </div>
        </template>
      </DataTable>
    </div>
  </div>
</template>
