<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import { formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

type FameTier = 'unknown' | 'niche' | 'notable' | 'famous' | 'iconic'
type FameTierFilter = FameTier | 'all'

interface FamousApp {
  app_id: string
  app_name: string | null
  icon_url: string | null
  ios_store_url: string | null
  android_store_url: string | null
  org_id: string
  org_name: string
  fame_score: number
  confidence: number
  tier: FameTier
  category: string | null
  known_as: string | null
  summary: string
  model: string
  checked_at: string
  device_count: number
}

interface FamousAppsResponse {
  success: boolean
  data: {
    apps: FamousApp[]
    total: number
    pending_count: number
    iconic_count: number
    famous_count: number
    notable_count: number
  }
}

const TIER_LABEL_KEYS: Record<FameTier, string> = {
  unknown: 'famous-apps-tier-unknown',
  niche: 'famous-apps-tier-niche',
  notable: 'famous-apps-tier-notable',
  famous: 'famous-apps-tier-famous',
  iconic: 'famous-apps-tier-iconic',
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()

const PAGE_SIZE = 50
const apps = ref<FamousApp[]>([])
const totalApps = ref(0)
const currentPage = ref(1)
const isLoadingApps = ref(false)
const pendingCount = ref(0)
const iconicCount = ref(0)
const famousCount = ref(0)
const notableCount = ref(0)
const searchQuery = ref('')
const minScore = ref(55)
const selectedTier = ref<FameTierFilter>('all')
let loadAppsSequence = 0
let searchReloadTimer: ReturnType<typeof setTimeout> | undefined

function formatNumber(value: number) {
  return formatNumberValue(value)
}

function formatTier(tier: FameTier) {
  return t(TIER_LABEL_KEYS[tier])
}

function cancelDebouncedSearchReload() {
  clearTimeout(searchReloadTimer)
  searchReloadTimer = undefined
}

async function loadApps() {
  const sequence = ++loadAppsSequence
  isLoadingApps.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const { start, end } = adminStore.activeDateRange
    const score = Number(minScore.value)
    const body: Record<string, unknown> = {
      metric_category: 'famous_apps',
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      limit: PAGE_SIZE,
      offset: (currentPage.value - 1) * PAGE_SIZE,
      min_score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    }

    if (selectedTier.value !== 'all')
      body.tier = selectedTier.value
    if (searchQuery.value.trim())
      body.search = searchQuery.value.trim()

    const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok)
      throw new Error(`API error: ${response.status}`)

    const payload = await response.json() as FamousAppsResponse
    if (sequence !== loadAppsSequence)
      return

    apps.value = payload.data?.apps ?? []
    totalApps.value = payload.data?.total ?? 0
    pendingCount.value = payload.data?.pending_count ?? 0
    iconicCount.value = payload.data?.iconic_count ?? 0
    famousCount.value = payload.data?.famous_count ?? 0
    notableCount.value = payload.data?.notable_count ?? 0
  }
  catch (error) {
    if (sequence !== loadAppsSequence)
      return
    console.error('[Admin Dashboard Famous Apps] Error loading apps:', error)
    apps.value = []
    totalApps.value = 0
  }
  finally {
    if (sequence === loadAppsSequence)
      isLoadingApps.value = false
  }
}

function loadAppsImmediately() {
  cancelDebouncedSearchReload()
  void loadApps()
}

function resetToFirstPageAndLoad() {
  currentPage.value = 1
  loadAppsImmediately()
}

function scheduleSearchReload() {
  cancelDebouncedSearchReload()
  searchReloadTimer = setTimeout(() => {
    searchReloadTimer = undefined
    resetToFirstPageAndLoad()
  }, 350)
}

const appColumns = computed<TableColumn[]>(() => [
  {
    label: t('app-name'),
    key: 'app_name',
    mobile: true,
    head: true,
    sortable: false,
    renderFunction: (item: FamousApp) => {
      const displayName = item.known_as || item.app_name || item.app_id
      return h('div', { class: 'flex min-w-0 items-center gap-3' }, [
        item.icon_url
          ? h('img', {
              src: item.icon_url,
              alt: displayName,
              class: 'h-10 w-10 shrink-0 rounded-lg object-cover',
            })
          : h('div', {
              class: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200',
            }, displayName.slice(0, 2).toUpperCase()),
        h('div', { class: 'min-w-0' }, [
          h('p', { class: 'truncate font-medium text-slate-900 dark:text-white' }, displayName),
          h('p', { class: 'truncate font-mono text-xs font-normal text-slate-500 dark:text-slate-400' }, item.app_id),
        ]),
      ])
    },
  },
  {
    label: t('org-name'),
    key: 'org_name',
    mobile: true,
    sortable: false,
    displayFunction: (item: FamousApp) => item.org_name || t('unknown'),
  },
  {
    label: t('famous-apps-score'),
    key: 'fame_score',
    mobile: true,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: FamousApp) => formatNumber(item.fame_score),
  },
  {
    label: t('famous-apps-tier'),
    key: 'tier',
    mobile: true,
    sortable: false,
    displayFunction: (item: FamousApp) => formatTier(item.tier),
  },
  {
    label: t('famous-apps-category'),
    key: 'category',
    mobile: false,
    sortable: false,
    displayFunction: (item: FamousApp) => item.category || t('unknown'),
  },
  {
    label: t('famous-apps-summary'),
    key: 'summary',
    mobile: false,
    sortable: false,
    class: 'max-w-sm',
    displayFunction: (item: FamousApp) => item.summary || t('unknown'),
  },
  {
    label: t('famous-apps-devices'),
    key: 'device_count',
    mobile: false,
    sortable: false,
    class: 'text-right',
    displayFunction: (item: FamousApp) => formatNumber(item.device_count),
  },
  {
    label: t('famous-apps-checked-at'),
    key: 'checked_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: FamousApp) => formatLocalDateTime(item.checked_at) || t('unknown'),
  },
])

watch(() => adminStore.refreshTrigger, () => {
  loadAppsImmediately()
})

watch([minScore, selectedTier], () => {
  resetToFirstPageAndLoad()
})

watch(searchQuery, () => {
  scheduleSearchReload()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin famous apps dashboard')
    router.push('/dashboard')
    return
  }

  await loadApps()
  displayStore.NavTitle = t('famous-apps')
})

onBeforeUnmount(cancelDebouncedSearchReload)

displayStore.NavTitle = t('famous-apps')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <p class="mb-4 text-sm text-slate-600 dark:text-slate-300">
          {{ t('famous-apps-subtitle') }}
        </p>

        <div class="grid grid-cols-1 gap-6 mb-6 sm:grid-cols-2 lg:grid-cols-4">
          <AdminStatsCard
            :title="t('famous-apps-iconic')"
            :value="iconicCount"
            :is-loading="isLoadingApps"
            color-class="text-amber-500"
          />
          <AdminStatsCard
            :title="t('famous-apps-famous')"
            :value="famousCount"
            :is-loading="isLoadingApps"
            color-class="text-[#119eff]"
          />
          <AdminStatsCard
            :title="t('famous-apps-notable')"
            :value="notableCount"
            :is-loading="isLoadingApps"
            color-class="text-emerald-500"
          />
          <AdminStatsCard
            :title="t('famous-apps-pending')"
            :value="pendingCount"
            :is-loading="isLoadingApps"
            color-class="text-slate-500"
            :subtitle="t('famous-apps-pending-subtitle')"
          />
        </div>

        <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
          <div class="flex flex-col gap-4 mb-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h3 class="text-lg font-semibold">
                {{ t('famous-apps') }}
              </h3>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('famous-apps-devices-hint') }}
              </p>
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:min-w-[720px]">
              <label for="admin-famous-apps-search" class="sr-only">{{ t('famous-apps-search') }}</label>
              <input
                id="admin-famous-apps-search"
                v-model="searchQuery"
                type="search"
                class="w-full d-input d-input-bordered d-input-sm"
                :placeholder="t('famous-apps-search')"
                :aria-label="t('famous-apps-search')"
              >

              <label for="admin-famous-apps-tier" class="sr-only">{{ t('famous-apps-all-tiers') }}</label>
              <select
                id="admin-famous-apps-tier"
                v-model="selectedTier"
                class="w-full d-select d-select-bordered d-select-sm"
                :aria-label="t('famous-apps-all-tiers')"
              >
                <option value="all">
                  {{ t('famous-apps-all-tiers') }}
                </option>
                <option value="iconic">
                  {{ t('famous-apps-tier-iconic') }}
                </option>
                <option value="famous">
                  {{ t('famous-apps-tier-famous') }}
                </option>
                <option value="notable">
                  {{ t('famous-apps-tier-notable') }}
                </option>
                <option value="niche">
                  {{ t('famous-apps-tier-niche') }}
                </option>
                <option value="unknown">
                  {{ t('famous-apps-tier-unknown') }}
                </option>
              </select>

              <label for="admin-famous-apps-min-score" class="sr-only">{{ t('famous-apps-min-score') }}</label>
              <input
                id="admin-famous-apps-min-score"
                v-model.number="minScore"
                type="number"
                min="0"
                max="100"
                class="w-full d-input d-input-bordered d-input-sm"
                :placeholder="t('famous-apps-min-score')"
                :aria-label="t('famous-apps-min-score')"
              >
            </div>
          </div>

          <DataTable
            :is-loading="isLoadingApps"
            :total="totalApps"
            :current-page="currentPage"
            :columns="appColumns"
            :element-list="apps"
            :auto-reload="false"
            @reload="loadAppsImmediately"
            @reset="loadAppsImmediately"
            @update:current-page="(page: number) => { currentPage = page; loadAppsImmediately() }"
          />
        </div>
      </div>
    </div>
  </div>
</template>
