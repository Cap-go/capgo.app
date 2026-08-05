<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { storeToRefs } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { checkPermissions } from '~/services/permissions'
import { createSignedImageUrl, resolveImagePath } from '~/services/storage'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useOrganizationStore } from '~/stores/organization'

const route = useRoute('/apps')
const router = useRouter()
const organizationStore = useOrganizationStore()
const isLoading = ref(true)
const isTableLoading = ref(false)
const supabase = useSupabase()
const { t } = useI18n()
const displayStore = useDisplayStore()
type AppRow = Database['public']['Tables']['apps']['Row']
type AppIconSource = AppRow | Database['public']['Functions']['get_org_apps_with_last_upload']['Returns'][number]
type AppRowWithIconState = AppRow & { icon_url_loading?: boolean, last_upload_at?: string | null }
const apps = ref<AppRowWithIconState[]>([])
const currentPage = ref(1)
const pageSize = 10
const totalApps = ref(0)
const searchQuery = ref('')
const { currentOrganization } = storeToRefs(organizationStore)
const canCreateApp = ref(false)
let appIconLoadRun = 0

// Check if user lacks security compliance (2FA or password) - don't load data in this case
const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

function normalizeAppRow(app: AppIconSource): AppRow {
  return {
    ...app,
    created_from_onboarding: 'created_from_onboarding' in app ? app.created_from_onboarding : false,
    onboarding_completed_at: 'onboarding_completed_at' in app ? app.onboarding_completed_at : null,
    rollout_channel_count: 'rollout_channel_count' in app ? app.rollout_channel_count : 0,
    rollout_paused_version_names: 'rollout_paused_version_names' in app ? app.rollout_paused_version_names : [],
  }
}

function appWithImmediateIcon(app: AppIconSource) {
  const appRow = normalizeAppRow(app)
  const { normalized, shouldSign } = resolveImagePath(appRow.icon_url)
  return {
    ...appRow,
    icon_url: shouldSign ? '' : normalized,
    icon_url_loading: shouldSign,
  }
}

function updateAppIconState(appId: string, patch: Partial<AppRowWithIconState>, runId: number) {
  if (appIconLoadRun !== runId)
    return

  for (const app of apps.value) {
    if (app.app_id === appId) {
      Object.assign(app, patch)
      return
    }
  }
}

async function loadAppIcon(app: AppIconSource, runId: number) {
  const appRow = normalizeAppRow(app)
  const { shouldSign } = resolveImagePath(appRow.icon_url)
  if (!shouldSign)
    return

  try {
    const signedIcon = await createSignedImageUrl(appRow.icon_url)
    updateAppIconState(appRow.app_id, {
      icon_url: signedIcon || '',
      icon_url_loading: false,
    }, runId)
  }
  catch (error) {
    console.warn('Cannot load signed app icon', { appId: appRow.app_id, error })
    updateAppIconState(appRow.app_id, { icon_url_loading: false }, runId)
  }
}

function loadAppIcons(sourceApps: AppIconSource[], runId: number) {
  for (const app of sourceApps) {
    loadAppIcon(app, runId).catch((error) => {
      console.warn('Cannot load signed app icon', { appId: app.app_id, error })
      updateAppIconState(app.app_id, { icon_url_loading: false }, runId)
    })
  }
}

async function getMyApps() {
  const currentRun = ++appIconLoadRun
  canCreateApp.value = false
  isTableLoading.value = true
  try {
    await organizationStore.awaitInitialLoad()

    // Don't fetch apps if user lacks security access - data would be rejected anyway
    if (lacksSecurityAccess.value) {
      apps.value = []
      totalApps.value = 0
      return
    }

    const currentGid = organizationStore.currentOrganization?.gid

    if (!currentGid) {
      console.error('Current organization is null, cannot fetch apps')
      apps.value = []
      totalApps.value = 0
      return
    }

    const hasCreateAppPermission = await checkPermissions('org.create_app', { orgId: currentGid })
    if (appIconLoadRun !== currentRun || organizationStore.currentOrganization?.gid !== currentGid)
      return

    canCreateApp.value = hasCreateAppPermission

    const offset = (currentPage.value - 1) * pageSize

    // Fetch the page via an RPC that derives each app's real last-upload time
    // (created_at of the bundle matching apps.last_version) and performs search,
    // ordering, pagination and the total count in SQL. This keeps the page order
    // consistent with the displayed "Last upload" sort, which apps.updated_at
    // (bumped by unrelated edits and background/cron jobs) cannot guarantee.
    const { data, error } = await supabase.rpc('get_org_apps_with_last_upload', {
      p_org_id: currentGid,
      p_search: searchQuery.value ? searchQuery.value.trim() : undefined,
      p_sort_by: 'last_upload_at',
      p_sort_desc: true,
      p_limit: pageSize,
      p_offset: offset,
    })

    if (appIconLoadRun !== currentRun)
      return

    if (error) {
      console.error('Cannot fetch apps', error)
      apps.value = []
      totalApps.value = 0
      return
    }

    const rows = data ?? []
    totalApps.value = rows[0]?.total_count ?? 0

    // appWithImmediateIcon spreads the whole RPC row, so last_upload_at is carried
    // through as-is. Avoid re-building the object inline (e.g. { ...appWithImmediateIcon(app),
    // last_upload_at } ) here: spreading into the AppRowWithIconState intersection makes
    // vue-tsc hit TS2589 (excessively deep type instantiation).
    apps.value = rows.map(appWithImmediateIcon)
    if (rows.length)
      loadAppIcons(rows, currentRun)
  }
  finally {
    isTableLoading.value = false
  }
}

watch(currentOrganization, async () => {
  currentPage.value = 1
  searchQuery.value = ''
  await getMyApps()
})

watchEffect(async () => {
  if (route.path === '/apps') {
    displayStore.NavTitle = ''
    isLoading.value = true
    await getMyApps()
    isLoading.value = false
  }
})

displayStore.NavTitle = t('apps')
displayStore.defaultBack = '/apps'
</script>

<template>
  <div>
    <!-- Show FailedCard when user lacks security access -->
    <div v-if="lacksSecurityAccess" class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <FailedCard />
    </div>
    <div v-else-if="!isLoading">
      <div class="relative h-full pb-4 overflow-hidden">
        <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
          <div
            v-if="totalApps === 0 && !searchQuery"
            class="relative p-8 mb-6 overflow-hidden bg-white border shadow-lg rounded-2xl border-violet-200/70 dark:border-slate-900 dark:bg-gray-900"
          >
            <span class="inline-flex rounded-full bg-violet-50 px-3 py-1 text-[11px] font-semibold tracking-[0.08em] text-violet-700 dark:bg-violet-900/30 dark:text-violet-200 dark:border-violet-800">
              {{ t('get-started') }}
            </span>
            <h2 class="mt-4 text-2xl font-semibold md:text-3xl text-slate-900 dark:text-slate-50">
              {{ t('start-using-capgo') }} <span class="font-prompt">Capgo</span> !
            </h2>
            <p class="max-w-2xl mt-3 text-slate-700 dark:text-slate-200">
              {{ t('add-your-first-app-t') }}
            </p>
            <div class="flex flex-col gap-3 mt-5 sm:flex-row sm:items-center">
              <button
                :aria-describedby="!canCreateApp ? 'cannot-add-app-no-permission' : undefined"
                :aria-disabled="!canCreateApp"
                :title="!canCreateApp ? t('cannot-add-app-no-permission') : undefined"
                class="d-btn d-btn-primary aria-disabled:cursor-not-allowed aria-disabled:border-gray-300 aria-disabled:bg-gray-200 aria-disabled:text-gray-500 dark:aria-disabled:border-gray-700 dark:aria-disabled:bg-gray-700 dark:aria-disabled:text-gray-400"
                @click="canCreateApp && router.push('/app/new')"
              >
                {{ t('start-onboarding') }}
              </button>
              <span v-if="!canCreateApp" id="cannot-add-app-no-permission" class="sr-only">{{ t('cannot-add-app-no-permission') }}</span>
            </div>
          </div>
          <!-- App table - always visible even when payment failed -->
          <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
            <AppTable
              :current-page="currentPage"
              :search="searchQuery"
              :apps="apps"
              :total="totalApps"
              :offset="pageSize"
              :delete-button="!organizationStore.currentOrganizationFailed"
              :server-side-pagination="true"
              :is-loading="isTableLoading"
              :add-disabled="!canCreateApp"
              :add-tooltip="t('cannot-add-app-no-permission')"
              @add-app="router.push('/app/new')"
              @update:current-page="(page) => { currentPage = page; getMyApps() }"
              @update:search="(query) => { searchQuery = query; currentPage = 1; getMyApps() }"
              @reload="getMyApps()"
              @reset="getMyApps()"
            />
          </div>
        </div>
      </div>
    </div>
    <PageLoader v-else />
  </div>
</template>
