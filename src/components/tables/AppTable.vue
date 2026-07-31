<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import type { Database } from '~/types/supabase.types'
import { Capacitor } from '@capacitor/core'
import { computed, h, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconSettings from '~icons/heroicons/cog-8-tooth'
import { formatDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { getRbacRoleI18nKey, useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  apps: (Database['public']['Tables']['apps']['Row'])[]
  deleteButton: boolean
  total?: number
  /** Fixed page size for server-side pagination controls */
  offset?: number
  currentPage?: number
  search?: string
  serverSidePagination?: boolean
  isLoading?: boolean
}>()
const emit = defineEmits([
  'addApp',
  'update:currentPage',
  'update:search',
  'reload',
  'reset',
])
const { t } = useI18n()
const isMobile = Capacitor.isNativePlatform()
const supabase = useSupabase()
const router = useRouter()
const internalSearch = ref(props.search || '')
const internalCurrentPage = ref(props.currentPage || 1)
const filters = ref({})
const main = useMainStore()
const organizationStore = useOrganizationStore()
const appRoleByAppId = ref<Map<string, string>>(new Map())
const appRoleLoaded = ref(false)

// Create enriched apps with MAU data
const appsWithMau = ref<any[]>([])
const mauDataLoaded = ref(false)

async function loadMauNumbers() {
// Wait for dashboard data to be loaded
  await main.awaitInitialLoad()

  // Map apps with their MAU values from the dashboard (last 30 days)
  appsWithMau.value = props.apps.map((app: any) => {
    // Get the app's dashboard data
    const appDashboard = main.dashboardByapp.filter(d => d.app_id === app.app_id)

    // Accumulate MAU values for the last 30 days (same default as usage charts)
    const mau = appDashboard.reduce((acc, entry) => acc + (entry.mau ?? 0), 0)

    return {
      ...app,
      mau,
    }
  })

  mauDataLoaded.value = true
}

watchEffect(async () => {
  if (props.apps.length > 0)
    await loadMauNumbers()
})

async function loadAppRoles() {
  const userId = main.user?.id
  const orgId = organizationStore.currentOrganization?.gid
  if (!userId || !orgId) {
    appRoleByAppId.value = new Map()
    appRoleLoaded.value = false
    return
  }

  appRoleLoaded.value = false
  try {
    const { data, error } = await supabase.rpc('get_org_user_access_rbac', {
      p_user_id: userId,
      p_org_id: orgId,
    })

    if (error)
      throw error

    const next = new Map<string, string>()
    for (const row of (data as any[] || [])) {
      if (row.scope_type === 'app' && row.app_id && row.role_name) {
        next.set(row.app_id, row.role_name)
      }
    }
    appRoleByAppId.value = next
  }
  catch (error) {
    console.error('Error loading app roles:', error)
    appRoleByAppId.value = new Map()
  }
  finally {
    appRoleLoaded.value = true
  }
}

watchEffect(async () => {
  if (props.apps.length > 0)
    await loadAppRoles()
})

function renderAvatar(item: any) {
  const sourceItem = props.apps.find((app: any) => app.app_id === item.app_id) as any || item
  const appName = sourceItem.name || item.name

  if (sourceItem.icon_url) {
    return h('img', {
      src: sourceItem.icon_url,
      alt: `App icon ${appName}`,
      class: 'mr-2 rounded-sm shrink-0 sm:mr-3 d-mask d-mask-squircle',
      width: 42,
      height: 42,
    })
  }

  if (sourceItem.icon_url_loading) {
    return h('div', {
      'class': 'flex items-center justify-center mr-2 bg-gray-700 rounded-sm shrink-0 sm:mr-3 d-mask d-mask-squircle',
      'style': 'width: 42px; height: 42px;',
      'aria-label': t('loading'),
    }, [
      h('span', { class: 'w-5 h-5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin' }),
      h('span', { class: 'sr-only' }, t('loading')),
    ])
  }

  return h('div', { class: 'p-2 mr-2 text-xl bg-gray-700 d-mask d-mask-squircle' }, [
    h('span', { class: 'font-medium text-gray-300' }, (appName?.slice(0, 2).toUpperCase() || 'AP')),
  ])
}

const columns = ref<TableColumn[]>([
  {
    label: t('name'),
    key: 'name',
    mobile: true,
    sortable: true,
    head: true,
    onClick: item => openPackage(item),
    renderFunction: (item) => {
      const avatar = renderAvatar(item)

      return h('div', { class: 'flex flex-wrap items-center text-slate-800 dark:text-white' }, [
        avatar,
        h('div', { class: 'max-w-max' }, item.name),
      ])
    },
  },
  {
    label: t('last-version'),
    key: 'last_version',
    mobile: true,
    sortable: true,
    onClick: item => openOneVersion(item),
  },
  {
    label: t('last-upload'),
    key: 'last_upload_at',
    mobile: false,
    sortable: 'desc',
    displayFunction: item => formatDate(item.last_upload_at ?? ''),
  },
  {
    label: t('mau'),
    key: 'mau',
    mobile: false,
    sortable: true,
  },
  {
    label: t('app-perm'),
    key: 'perm',
    mobile: false,
    displayFunction: (item) => {
      if (!appRoleLoaded.value)
        return t('loading')

      const appRole = appRoleByAppId.value.get(item.app_id)
      const orgRole = organizationStore.getOrgByAppId(item.app_id)?.role
      const roleName = appRole || orgRole

      if (!roleName)
        return t('unknown')

      // Get i18n key and translate, or fallback to human-readable format
      const i18nKey = getRbacRoleI18nKey(roleName)
      return i18nKey ? t(i18nKey) : roleName.replaceAll('_', ' ')
    },
  },
  {
    label: '',
    key: 'actions',
    mobile: true,
    actions: [
      {
        icon: IconSettings,
        onClick: item => openSettings(item),
      },
    ],
  },
])

function openSettings(app: Database['public']['Tables']['apps']['Row']) {
  router.push(`/app/${app.app_id}/info`)
}

function openPackage(app: Database['public']['Tables']['apps']['Row']) {
  router.push(`/app/${app.app_id}`)
}

async function openOneVersion(app: Database['public']['Tables']['apps']['Row']) {
  if (!app.last_version)
    return
  const { data: versionData } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', app.app_id)
    .eq('name', app.last_version)
    .single()

  router.push(`/app/${app.app_id}/bundle/${versionData?.id}`)
}

type SortableApp = Record<string, any>

type SortDirection = 'asc' | 'desc'

function normalizeSortValue(value: any, key: string) {
  if (key === 'mau')
    return value ?? 0

  return value ?? ''
}

function compareSortValues(aVal: any, bVal: any, direction: SortDirection) {
  if (typeof aVal === 'number' && typeof bVal === 'number') {
    const numericComparison = aVal - bVal
    return direction === 'asc' ? numericComparison : -numericComparison
  }

  const stringComparison = String(aVal).toLowerCase().localeCompare(String(bVal).toLowerCase())
  return direction === 'asc' ? stringComparison : -stringComparison
}

function sortAppsByColumn(apps: SortableApp[], sortColumn: TableColumn) {
  const key = sortColumn.key
  const direction: SortDirection = sortColumn.sortable === 'asc' ? 'asc' : 'desc'

  return [...apps].sort((a, b) => compareSortValues(
    normalizeSortValue(a[key], key),
    normalizeSortValue(b[key], key),
    direction,
  ))
}

// Filter apps based on search term
const filteredApps = computed(() => {
  // If MAU data isn't loaded yet, return original apps
  if (!mauDataLoaded.value) {
    // Return original apps while MAU is loading (without MAU column being sortable)
    return props.apps as any[]
  }

  let apps = appsWithMau.value

  // Apply search filter (only for client-side pagination)
  if (!props.serverSidePagination && internalSearch.value) {
    const searchLower = internalSearch.value.toLowerCase()
    apps = apps.filter((app) => {
      // Search by name (primary)
      const nameMatch = app.name?.toLowerCase().includes(searchLower)

      // Search by app_id (bundle ID - bonus feature)
      const bundleIdMatch = app.app_id.toLowerCase().includes(searchLower)

      return nameMatch || bundleIdMatch
    })
  }

  // Apply sorting by the raw value so dates order by ISO timestamps instead of localized labels.
  const sortColumn = columns.value.find(col => col.sortable && typeof col.sortable === 'string')
  if (sortColumn)
    return sortAppsByColumn(apps, sortColumn)

  return apps
})
</script>

<template>
  <div class="block w-full pb-14 md:pb-0">
    <div
      class="w-full bg-transparent border-none rounded-none shadow-none col-span-full md:bg-white md:rounded-lg md:border md:shadow-lg dark:bg-transparent md:dark:border-slate-800 md:dark:bg-gray-800 xl:col-span-16"
    >
      <DataTable
        v-model:filters="filters"
        v-model:columns="columns"
        v-model:current-page="internalCurrentPage"
        v-model:search="internalSearch"
        :show-add="!isMobile"
        :total="props.total ?? filteredApps.length"
        :offset="props.offset"
        :element-list="filteredApps"
        :search-placeholder="t('search-by-name-or-app-id')"
        :is-loading="props.isLoading ?? false"
        :auto-reload="false"
        filter-text="Filters"
        @add="emit('addApp')"
        @reload="emit('reload')"
        @reset="emit('reset')"
        @update:current-page="(page) => emit('update:currentPage', page)"
        @update:search="(val) => emit('update:search', val)"
      />
    </div>
  </div>
</template>
