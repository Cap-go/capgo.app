<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { TableColumn } from '~/components/comp_def'
import type { AppOnboardingMethodTrendPoint, AppOnboardingOutcomeTrendPoint } from '~/services/adminAppOnboarding'
import type { RegistrationSourceTrendPoint } from '~/services/adminRegistrationSources'
import { computed, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminBarChart from '~/components/admin/AdminBarChart.vue'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { aggregateAppOnboardingMethodTotals, aggregateAppOnboardingOutcomeTotals } from '~/services/adminAppOnboarding'
import { aggregateRegistrationSourceTotals } from '~/services/adminRegistrationSources'
import { formatLocalDate, formatLocalDateTime } from '~/services/date'
import { formatNumberValue, formatOneDecimal } from '~/services/formatLocale'
import { getEmoji } from '~/services/i18n'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { locale, t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)

// Onboarding funnel data
interface OnboardingFunnelData {
  total_registrations: number
  total_orgs: number
  orgs_with_app: number
  orgs_with_channel: number
  orgs_with_bundle: number
  orgs_subscribed: number
  orgs_with_production_device: number
  orgs_with_update_download: number
  orgs_with_testflight: number
  orgs_with_store_live: number
  activation_telemetry_available: boolean
  total_invite_registrations: number
  total_org_joins_invite_register: number
  total_org_joins_existing_account: number
  org_conversion_rate: number
  app_conversion_rate: number
  channel_conversion_rate: number
  bundle_conversion_rate: number
  subscription_conversion_rate: number
  production_device_conversion_rate: number
  update_download_conversion_rate: number
  testflight_conversion_rate: number
  store_live_conversion_rate: number
  trend: Array<{
    date: string
    new_registrations: number
    new_orgs: number
    orgs_created_app: number
    orgs_created_channel: number
    orgs_created_bundle: number
    orgs_subscribed: number
    orgs_with_production_device: number
    orgs_with_update_download: number
    orgs_with_testflight: number
    orgs_with_store_live: number
  }>
  invite_trend: Array<{
    date: string
    invite_registrations: number
    org_joins_invite_register: number
    org_joins_existing_account: number
  }>
  registration_source_trend: RegistrationSourceTrendPoint[]
  onboarding_method_trend: AppOnboardingMethodTrendPoint[]
  onboarding_outcome_trend: AppOnboardingOutcomeTrendPoint[]
}

interface EmailTypeBreakdown {
  totals: {
    professional: number
    personal: number
    disposable: number
    total: number
  }
  trend: Array<{
    date: string
    professional: number
    personal: number
    disposable: number
    total: number
  }>
}

interface CustomerCountryBreakdown {
  total_organizations: number
  countries: Array<{
    country_code: string
    organizations: number
    percentage: number
  }>
}

interface TrialPlanBreakdown {
  totals: Array<{
    plan_name: string
    total: number
  }>
  trend: Array<{
    date: string
    total: number
    plans: Record<string, number>
  }>
}

const onboardingFunnelData = ref<OnboardingFunnelData | null>(null)
const isLoadingOnboardingFunnel = ref(false)
const emailTypeBreakdown = ref<EmailTypeBreakdown | null>(null)
const isLoadingEmailTypeBreakdown = ref(false)
const customerCountryBreakdown = ref<CustomerCountryBreakdown | null>(null)
const isLoadingCustomerCountryBreakdown = ref(false)
const trialPlanBreakdown = ref<TrialPlanBreakdown | null>(null)
const isLoadingTrialPlanBreakdown = ref(false)

// Global stats trend data
const globalStatsTrendData = ref<Array<{
  date: string
  apps: number
  apps_active: number
  users: number
  users_active: number
  paying: number
  trial: number
  not_paying: number
  updates: number
  updates_external: number
  success_rate: number
  bundle_storage_gb: number
  plan_solo: number
  plan_maker: number
  plan_team: number
  plan_enterprise: number
  plan_credits: number
  registers_today: number
  new_paying_orgs: number
  apps_created: number
  versions_created: number
  demo_apps_created: number
  apps_with_preview: number
  devices_last_month: number
  trial_extended_orgs: number
  trial_extended_subscribed_orgs: number
  paying_orgs_subscription?: number
  paying_orgs_credits?: number
  paying_orgs_total?: number
}>>([])

const isLoadingGlobalStatsTrend = ref(false)

// Trial organizations data
interface TrialOrganization {
  org_id: string
  org_name: string
  management_email: string
  plan_name: string | null
  trial_end_date: string
  days_remaining: number
  trial_extension_count: number
  created_at: string
  last_bundle_upload_at: string | null
}

interface TrialOrganizationsResponse {
  success: boolean
  data: {
    organizations: TrialOrganization[]
    total: number
  }
}

interface CancelledOrganization {
  org_id: string
  org_name: string
  management_email: string
  canceled_at: string
  plan_name: string | null
  billing_type: 'monthly' | 'yearly' | null
  subscription_or_signup_date: string
  cancellation_reason: string | null
}

interface CancelledOrganizationsResponse {
  success: boolean
  data: {
    organizations: CancelledOrganization[]
    total: number
  }
}

const trialOrganizations = ref<TrialOrganization[]>([])
const trialOrganizationsTotal = ref(0)
const trialOrganizationsCurrentPage = ref(1)
const isLoadingTrialOrganizations = ref(false)
const TRIAL_PAGE_SIZE = 20

const cancelledOrganizations = ref<CancelledOrganization[]>([])
const cancelledOrganizationsTotal = ref(0)
const cancelledOrganizationsCurrentPage = ref(1)
const isLoadingCancelledOrganizations = ref(false)
const CANCELLED_PAGE_SIZE = 20

function getTrialExtensionBadgeLabel(extensionCount: number) {
  return t('trial-extended-badge', { count: extensionCount })
}

const trialOrganizationsColumns = ref<TableColumn[]>([
  {
    label: t('org-name'),
    key: 'org_name',
    mobile: true,
    head: true,
    sortable: false,
    renderFunction: (item: TrialOrganization) => h('div', { class: 'flex flex-wrap items-center gap-2 text-slate-800 dark:text-white' }, [
      h('span', { class: 'font-medium' }, item.org_name),
      item.trial_extension_count > 0
        ? h('span', {
            class: 'inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-200',
          }, getTrialExtensionBadgeLabel(item.trial_extension_count))
        : null,
    ]),
  },
  { label: t('email'), key: 'management_email', mobile: false, sortable: false },
  {
    label: t('plan'),
    key: 'plan_name',
    mobile: true,
    sortable: false,
    displayFunction: (item: TrialOrganization) => item.plan_name || t('unknown'),
  },
  {
    label: t('days-remaining'),
    key: 'days_remaining',
    mobile: true,
    sortable: false,
    displayFunction: (item: TrialOrganization) => {
      if (item.days_remaining === 0)
        return t('expires-today')
      if (item.days_remaining === 1)
        return `1 ${t('day')}`
      return `${formatNumberValue(item.days_remaining)} ${t('days')}`
    },
  },
  {
    label: t('trial-end-date'),
    key: 'trial_end_date',
    mobile: false,
    sortable: false,
    displayFunction: (item: TrialOrganization) => {
      return formatLocalDate(item.trial_end_date)
    },
  },
  {
    label: t('last-upload'),
    key: 'last_bundle_upload_at',
    mobile: false,
    sortable: false,
    displayFunction: (item: TrialOrganization) => {
      return formatLocalDateTime(item.last_bundle_upload_at) || t('never')
    },
  },
])

function formatBillingTypeLabel(billingType: CancelledOrganization['billing_type']) {
  if (billingType === 'yearly')
    return t('yearly')
  if (billingType === 'monthly')
    return t('monthly')
  return t('unknown')
}

const cancelledOrganizationsColumns = ref<TableColumn[]>([
  { label: t('org-name'), key: 'org_name', mobile: true, head: true, sortable: false },
  { label: t('email'), key: 'management_email', mobile: false, sortable: false },
  {
    label: t('cancellation-date'),
    key: 'canceled_at',
    mobile: true,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => {
      if (!item.canceled_at)
        return t('unknown')
      return formatLocalDate(item.canceled_at)
    },
  },
  {
    label: t('plan'),
    key: 'plan_name',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => item.plan_name || t('unknown'),
  },
  {
    label: t('billing-cycle'),
    key: 'billing_type',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => formatBillingTypeLabel(item.billing_type),
  },
  {
    label: t('subscription-or-signup-date'),
    key: 'subscription_or_signup_date',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => formatLocalDate(item.subscription_or_signup_date) || t('unknown'),
  },
  {
    label: t('cancellation-reason'),
    key: 'cancellation_reason',
    mobile: false,
    sortable: false,
    displayFunction: (item: CancelledOrganization) => item.cancellation_reason || t('unknown'),
  },
])

async function loadTrialOrganizations() {
  isLoadingTrialOrganizations.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const offset = (trialOrganizationsCurrentPage.value - 1) * TRIAL_PAGE_SIZE

    // Note: start_date and end_date are required by the API schema but not used for trial_organizations
    // which queries current trial status rather than time-series data
    const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        metric_category: 'trial_organizations',
        start_date: new Date().toISOString(),
        end_date: new Date().toISOString(),
        limit: TRIAL_PAGE_SIZE,
        offset,
      }),
    })

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}))
      throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const data = await response.json() as TrialOrganizationsResponse
    if (!data.success)
      throw new Error('Failed to fetch trial organizations')

    trialOrganizations.value = data.data.organizations || []
    trialOrganizationsTotal.value = data.data.total || 0
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading trial organizations:', error)
    trialOrganizations.value = []
    trialOrganizationsTotal.value = 0
  }
  finally {
    isLoadingTrialOrganizations.value = false
  }
}

async function loadCancelledOrganizations() {
  isLoadingCancelledOrganizations.value = true
  try {
    const supabase = useSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session)
      throw new Error('Not authenticated')

    const offset = (cancelledOrganizationsCurrentPage.value - 1) * CANCELLED_PAGE_SIZE

    const { start, end } = adminStore.activeDateRange
    const response = await fetch(`${defaultApiHost}/private/admin_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        metric_category: 'cancelled_users',
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        limit: CANCELLED_PAGE_SIZE,
        offset,
      }),
    })

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}))
      throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`)
    }

    const data = await response.json() as CancelledOrganizationsResponse
    if (!data.success)
      throw new Error('Failed to fetch cancelled organizations')

    cancelledOrganizations.value = data.data.organizations || []
    cancelledOrganizationsTotal.value = data.data.total || 0
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading cancelled organizations:', error)
    cancelledOrganizations.value = []
    cancelledOrganizationsTotal.value = 0
  }
  finally {
    isLoadingCancelledOrganizations.value = false
  }
}

async function loadGlobalStatsTrend() {
  isLoadingGlobalStatsTrend.value = true
  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    console.log('[Admin Dashboard Users] Global stats trend data:', data)
    globalStatsTrendData.value = data || []
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    isLoadingGlobalStatsTrend.value = false
  }
}

async function loadOnboardingFunnel() {
  isLoadingOnboardingFunnel.value = true
  try {
    const data = await adminStore.fetchStats('onboarding_funnel')
    console.log('[Admin Dashboard Users] Onboarding funnel data:', data)
    onboardingFunnelData.value = data || null
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading onboarding funnel:', error)
    onboardingFunnelData.value = null
  }
  finally {
    isLoadingOnboardingFunnel.value = false
  }
}

async function loadEmailTypeBreakdown() {
  isLoadingEmailTypeBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('email_type_breakdown')
    emailTypeBreakdown.value = data as EmailTypeBreakdown
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading email type breakdown:', error)
    emailTypeBreakdown.value = null
  }
  finally {
    isLoadingEmailTypeBreakdown.value = false
  }
}

async function loadCustomerCountryBreakdown() {
  isLoadingCustomerCountryBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('customer_country_breakdown')
    customerCountryBreakdown.value = data as CustomerCountryBreakdown
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading customer country breakdown:', error)
    customerCountryBreakdown.value = null
  }
  finally {
    isLoadingCustomerCountryBreakdown.value = false
  }
}

async function loadTrialPlanBreakdown() {
  isLoadingTrialPlanBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('trial_plan_breakdown')
    trialPlanBreakdown.value = data as TrialPlanBreakdown
  }
  catch (error) {
    console.error('[Admin Dashboard Users] Error loading trial plan breakdown:', error)
    trialPlanBreakdown.value = null
  }
  finally {
    isLoadingTrialPlanBreakdown.value = false
  }
}

const countryDisplayNames = computed(() => {
  try {
    return new Intl.DisplayNames([locale.value || 'en'], { type: 'region' })
  }
  catch {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  }
})

function normalizeCountryCode(countryCode: string) {
  return countryCode.trim().toUpperCase()
}

function getCountryLabel(countryCode: string) {
  const normalizedCountryCode = normalizeCountryCode(countryCode)
  return countryDisplayNames.value.of(normalizedCountryCode) ?? normalizedCountryCode
}

function getCountryFlag(countryCode: string) {
  try {
    return getEmoji(normalizeCountryCode(countryCode))
  }
  catch {
    return '🌐'
  }
}

// Computed properties for multi-line charts
const usersTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Paying Organizations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.paying,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Trial Organizations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.trial,
      })),
      color: '#f59e0b', // amber
    },
  ]
})

const emailTypeTotals = computed(() => emailTypeBreakdown.value?.totals ?? {
  professional: 0,
  personal: 0,
  disposable: 0,
  total: 0,
})

const emailTypeTrendSeries = computed(() => {
  const trend = emailTypeBreakdown.value?.trend ?? []
  if (trend.length === 0)
    return []

  return [
    {
      label: t('admin-users-email-type-professional'),
      data: trend.map(item => ({
        date: item.date,
        value: item.professional,
      })),
      color: '#119eff',
    },
    {
      label: t('admin-users-email-type-personal'),
      data: trend.map(item => ({
        date: item.date,
        value: item.personal,
      })),
      color: '#10b981',
    },
    {
      label: t('admin-users-email-type-disposable'),
      data: trend.map(item => ({
        date: item.date,
        value: item.disposable,
      })),
      color: '#ef4444',
    },
  ]
})

const customerCountryEntries = computed(() => customerCountryBreakdown.value?.countries ?? [])
const topCustomerCountryEntries = computed(() => customerCountryEntries.value.slice(0, 10))

const customerCountryTotalOrganizations = computed(() => customerCountryBreakdown.value?.total_organizations ?? 0)
const customerCountryUniqueCountries = computed(() => customerCountryEntries.value.length)
const leadingCustomerCountry = computed(() => topCustomerCountryEntries.value[0] ?? null)
const leadingCustomerCountrySubtitle = computed(() => {
  if (!leadingCustomerCountry.value)
    return t('admin-users-country-top-country-empty')

  return t('admin-users-country-top-country-description', {
    country: getCountryLabel(leadingCustomerCountry.value.country_code),
    count: formatNumberValue(leadingCustomerCountry.value.organizations),
    share: formatOneDecimal(leadingCustomerCountry.value.percentage),
  })
})

const customerCountryChartLabels = computed(() => topCustomerCountryEntries.value.map(country => `${getCountryFlag(country.country_code)} ${getCountryLabel(country.country_code)}`))
const customerCountryChartValues = computed(() => topCustomerCountryEntries.value.map(country => country.organizations))

const trialPlanBreakdownTotal = computed(() => {
  const totals = trialPlanBreakdown.value?.totals ?? []
  return totals.reduce((sum, plan) => sum + plan.total, 0)
})

const trialPlanBreakdownPlanNames = computed(() => {
  const totals = trialPlanBreakdown.value?.totals ?? []
  return totals.map(plan => plan.plan_name)
})

const trialPlanChartColors: Record<string, string> = {
  Solo: '#119eff',
  Maker: '#d97706',
  Team: '#8b5cf6',
  Enterprise: '#059669',
}

const fallbackTrialPlanChartColors = ['#119eff', '#d97706', '#8b5cf6', '#059669', '#db2777', '#0f766e', '#dc2626']

function getTrialPlanChartColor(planName: string, index: number) {
  return trialPlanChartColors[planName] ?? fallbackTrialPlanChartColors[index % fallbackTrialPlanChartColors.length]
}

const trialPlanBreakdownTrendSeries = computed(() => {
  const trend = trialPlanBreakdown.value?.trend ?? []
  if (trend.length === 0 || trialPlanBreakdownPlanNames.value.length === 0)
    return []

  return trialPlanBreakdownPlanNames.value
    .map((planName, index) => ({
      label: planName,
      data: trend.map(item => ({
        date: item.date,
        value: item.plans[planName] ?? 0,
      })),
      color: getTrialPlanChartColor(planName, index),
    }))
    .filter(series => series.data.some(item => item.value > 0))
})

const registrationsTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Daily Registrations',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.registers_today,
      })),
      color: '#3b82f6', // blue
    },
  ]
})

const registrationToSubscriptionConversionSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('registration-to-subscription-conversion'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.registers_today > 0
          ? (item.new_paying_orgs / item.registers_today) * 100
          : 0,
      })),
      color: '#8b5cf6', // violet
    },
  ]
})

const appsCreatedTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('admin-apps-created-by-day-series'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.apps_created ?? 0,
      })),
      color: '#2563eb',
    },
  ]
})

const versionsCreatedTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('admin-versions-uploaded-by-day-series'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.versions_created ?? 0,
      })),
      color: '#10b981',
    },
  ]
})

const appsWithPreviewTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('admin-apps-with-preview-series'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.apps_with_preview ?? 0,
      })),
      color: '#119eff',
    },
  ]
})

const trialExtensionTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: t('trial-extensions'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.trial_extended_orgs ?? 0,
      })),
      color: '#119eff',
    },
    {
      label: t('extended-trial-subscriptions'),
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.trial_extended_subscribed_orgs ?? 0,
      })),
      color: '#10b981',
    },
  ]
})

const planDistributionData = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  const latest = globalStatsTrendData.value[globalStatsTrendData.value.length - 1]
  const total = latest.plan_solo + latest.plan_maker + latest.plan_team + latest.plan_enterprise + (latest.plan_credits ?? 0)

  return [
    {
      label: 'Solo',
      value: latest.plan_solo,
      percentage: total > 0 ? formatOneDecimal((latest.plan_solo / total) * 100) : formatOneDecimal(0),
    },
    {
      label: 'Maker',
      value: latest.plan_maker,
      percentage: total > 0 ? formatOneDecimal((latest.plan_maker / total) * 100) : formatOneDecimal(0),
    },
    {
      label: 'Team',
      value: latest.plan_team,
      percentage: total > 0 ? formatOneDecimal((latest.plan_team / total) * 100) : formatOneDecimal(0),
    },
    {
      label: 'Enterprise',
      value: latest.plan_enterprise,
      percentage: total > 0 ? formatOneDecimal((latest.plan_enterprise / total) * 100) : formatOneDecimal(0),
    },
    {
      label: 'Credits',
      value: latest.plan_credits ?? 0,
      percentage: total > 0 ? formatOneDecimal(((latest.plan_credits ?? 0) / total) * 100) : formatOneDecimal(0),
    },
  ]
})

const planDistributionTrendSeries = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return []

  return [
    {
      label: 'Solo',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_solo,
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: 'Maker',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_maker,
      })),
      color: '#ec4899', // pink
    },
    {
      label: 'Team',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_team,
      })),
      color: '#10b981', // green
    },
    {
      label: 'Enterprise',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_enterprise,
      })),
      color: '#f59e0b', // amber
    },
    {
      label: 'Credits',
      data: globalStatsTrendData.value.map(item => ({
        date: item.date,
        value: item.plan_credits ?? 0,
      })),
      color: '#119eff', // azure
    },
  ]
})

const latestGlobalStats = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return null
  return globalStatsTrendData.value[globalStatsTrendData.value.length - 1]
})

const onboardingFunnelRates = computed(() => {
  if (!onboardingFunnelData.value) {
    return {
      org: 0,
      app: 0,
      channel: 0,
      bundle: 0,
      subscribed: 0,
      productionDevice: 0,
      updateDownload: 0,
      testflight: 0,
      storeLive: 0,
    }
  }

  const totalRegistrations = Number(onboardingFunnelData.value.total_registrations) || 0
  const totalOrgs = Number(onboardingFunnelData.value.total_orgs) || 0
  const orgsWithApp = Number(onboardingFunnelData.value.orgs_with_app) || 0
  const orgsWithChannel = Number(onboardingFunnelData.value.orgs_with_channel) || 0
  const orgsWithBundle = Number(onboardingFunnelData.value.orgs_with_bundle) || 0
  const orgsSubscribed = Number(onboardingFunnelData.value.orgs_subscribed) || 0
  const orgsWithProductionDevice = Number(onboardingFunnelData.value.orgs_with_production_device) || 0
  const orgsWithUpdateDownload = Number(onboardingFunnelData.value.orgs_with_update_download) || 0
  const orgsWithTestflight = Number(onboardingFunnelData.value.orgs_with_testflight) || 0
  const orgsWithStoreLive = Number(onboardingFunnelData.value.orgs_with_store_live) || 0

  return {
    org: totalRegistrations > 0 ? (totalOrgs / totalRegistrations) * 100 : 0,
    app: totalOrgs > 0 ? (orgsWithApp / totalOrgs) * 100 : 0,
    channel: orgsWithApp > 0 ? (orgsWithChannel / orgsWithApp) * 100 : 0,
    bundle: orgsWithChannel > 0 ? (orgsWithBundle / orgsWithChannel) * 100 : 0,
    subscribed: orgsWithBundle > 0 ? (orgsSubscribed / orgsWithBundle) * 100 : 0,
    productionDevice: orgsWithBundle > 0 ? (orgsWithProductionDevice / orgsWithBundle) * 100 : 0,
    updateDownload: orgsWithProductionDevice > 0 ? (orgsWithUpdateDownload / orgsWithProductionDevice) * 100 : 0,
    testflight: orgsWithBundle > 0 ? (orgsWithTestflight / orgsWithBundle) * 100 : 0,
    storeLive: orgsWithBundle > 0 ? (orgsWithStoreLive / orgsWithBundle) * 100 : 0,
  }
})

const onboardingFunnelConversionSummaries = computed(() => {
  const rates = onboardingFunnelRates.value
  const items = [
    {
      key: 'org',
      value: rates.org,
      label: t('register-to-org'),
      colorClass: 'text-sky-500',
    },
    {
      key: 'app',
      value: rates.app,
      label: t('org-to-app'),
      colorClass: 'text-purple-500',
    },
    {
      key: 'channel',
      value: rates.channel,
      label: t('app-to-channel'),
      colorClass: 'text-amber-500',
    },
    {
      key: 'bundle',
      value: rates.bundle,
      label: t('channel-to-bundle'),
      colorClass: 'text-emerald-500',
    },
    {
      key: 'testflight',
      value: rates.testflight,
      label: t('bundle-to-testflight'),
      colorClass: 'text-cyan-500',
    },
    {
      key: 'storeLive',
      value: rates.storeLive,
      label: t('bundle-to-store-live'),
      colorClass: 'text-teal-500',
    },
  ]

  if (onboardingFunnelData.value?.activation_telemetry_available) {
    items.push(
      {
        key: 'productionDevice',
        value: rates.productionDevice,
        label: t('bundle-to-production-device'),
        colorClass: 'text-pink-500',
      },
      {
        key: 'updateDownload',
        value: rates.updateDownload,
        label: t('production-device-to-update-download'),
        colorClass: 'text-indigo-500',
      },
    )
  }

  items.push({
    key: 'subscribed',
    value: rates.subscribed,
    label: t('bundle-to-subscribed'),
    colorClass: 'text-rose-500',
  })

  return items
})

const onboardingFunnelConversionGridClass = computed(() => {
  // Keep one row on large screens so rates follow the funnel columns.
  const count = onboardingFunnelConversionSummaries.value.length
  if (count >= 9)
    return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9'
  if (count >= 7)
    return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-7'
  if (count >= 6)
    return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
  return 'grid-cols-2 sm:grid-cols-4'
})

// Onboarding funnel stages for display
const onboardingFunnelStages = computed(() => {
  if (!onboardingFunnelData.value)
    return []

  const data = onboardingFunnelData.value
  const rates = onboardingFunnelRates.value
  return [
    {
      label: t('user-registrations'),
      value: Number(data.total_registrations) || 0,
      percentage: 100,
      color: '#0ea5e9', // sky
    },
    {
      label: t('organizations-created'),
      value: Number(data.total_orgs) || 0,
      percentage: rates.org,
      color: '#3b82f6', // blue
    },
    {
      label: t('created-an-app'),
      value: Number(data.orgs_with_app) || 0,
      percentage: rates.app,
      color: '#8b5cf6', // purple
    },
    {
      label: t('created-a-channel'),
      value: Number(data.orgs_with_channel) || 0,
      percentage: rates.channel,
      color: '#f59e0b', // amber
    },
    {
      label: t('uploaded-a-bundle'),
      value: Number(data.orgs_with_bundle) || 0,
      percentage: rates.bundle,
      color: '#10b981', // green
    },
    {
      label: t('reached-testflight'),
      value: Number(data.orgs_with_testflight) || 0,
      percentage: rates.testflight,
      color: '#06b6d4', // cyan
    },
    {
      label: t('reached-app-store-live'),
      value: Number(data.orgs_with_store_live) || 0,
      percentage: rates.storeLive,
      color: '#0d9488', // teal
    },
    ...(data.activation_telemetry_available
      ? [
          {
            label: t('production-plugin-device'),
            value: Number(data.orgs_with_production_device) || 0,
            percentage: rates.productionDevice,
            color: '#ec4899', // pink
          },
          {
            label: t('completed-update-download'),
            value: Number(data.orgs_with_update_download) || 0,
            percentage: rates.updateDownload,
            color: '#6366f1', // indigo
          },
        ]
      : []),
  ]
})

// Onboarding funnel trend for multi-line chart
function normalizeTrendDate(value: string) {
  return value.includes('T') ? value.split('T')[0] : value
}

const onboardingFunnelTrendSeries = computed(() => {
  if (!onboardingFunnelData.value || !onboardingFunnelData.value.trend)
    return []

  const trend = onboardingFunnelData.value.trend
  const demoAppsCreatedByDate = new Map(globalStatsTrendData.value.map(item => [normalizeTrendDate(item.date), item.demo_apps_created]))
  return [
    {
      label: t('user-registrations'),
      data: trend.map(item => ({
        date: item.date,
        value: item.new_registrations,
      })),
      color: '#0ea5e9', // sky
    },
    {
      label: t('new-organizations'),
      data: trend.map(item => ({
        date: item.date,
        value: item.new_orgs,
      })),
      color: '#8b5cf6', // purple
    },
    {
      label: t('created-app-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_created_app,
      })),
      color: '#2563eb', // blue
    },
    {
      label: t('created-channel-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_created_channel,
      })),
      color: '#f59e0b', // amber
    },
    {
      label: t('uploaded-bundle-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_created_bundle,
      })),
      color: '#10b981', // green
    },
    {
      label: t('reached-testflight-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_with_testflight,
      })),
      color: '#06b6d4', // cyan
    },
    {
      label: t('reached-app-store-live-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_with_store_live,
      })),
      color: '#0d9488', // teal
    },
    ...(onboardingFunnelData.value.activation_telemetry_available
      ? [
          {
            label: t('production-plugin-device-within-7-days'),
            data: trend.map(item => ({
              date: item.date,
              value: item.orgs_with_production_device,
            })),
            color: '#ec4899', // pink
          },
          {
            label: t('completed-update-download-within-7-days'),
            data: trend.map(item => ({
              date: item.date,
              value: item.orgs_with_update_download,
            })),
            color: '#6366f1', // indigo
          },
        ]
      : []),
    {
      label: t('demo-apps-created'),
      data: trend.map(item => ({
        date: item.date,
        value: demoAppsCreatedByDate.get(normalizeTrendDate(item.date)) ?? 0,
      })),
      color: '#ef4444', // red
    },
    {
      label: t('subscribed-within-7-days'),
      data: trend.map(item => ({
        date: item.date,
        value: item.orgs_subscribed,
      })),
      color: '#14b8a6', // teal
    },
  ]
})

const inviteJoinTrendSeries = computed(() => {
  const inviteTrend = onboardingFunnelData.value?.invite_trend
  if (!inviteTrend || inviteTrend.length === 0)
    return []

  return [
    {
      label: t('invite-registrations'),
      data: inviteTrend.map(item => ({
        date: item.date,
        value: Number(item.invite_registrations) || 0,
      })),
      color: '#f97316', // orange
    },
    {
      label: t('org-joins-invite-register'),
      data: inviteTrend.map(item => ({
        date: item.date,
        value: Number(item.org_joins_invite_register) || 0,
      })),
      color: '#06b6d4', // cyan
    },
    {
      label: t('org-joins-existing-account'),
      data: inviteTrend.map(item => ({
        date: item.date,
        value: Number(item.org_joins_existing_account) || 0,
      })),
      color: '#a855f7', // purple
    },
  ]
})

const registrationSourceTotals = computed(() => {
  return aggregateRegistrationSourceTotals(onboardingFunnelData.value?.registration_source_trend ?? [])
})

const registrationSourceTrendSeries = computed(() => {
  const trend = onboardingFunnelData.value?.registration_source_trend
  if (!trend || trend.length === 0)
    return []

  return [
    {
      label: t('normal-registration'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.normal_registrations) || 0,
      })),
      color: '#3b82f6',
    },
    {
      label: t('organization-invite'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.invite_registrations) || 0,
      })),
      color: '#f97316',
    },
    {
      label: t('without-profile'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.without_profile) || 0,
      })),
      color: '#94a3b8',
    },
  ]
})

const appOnboardingMethodTotals = computed(() => {
  return aggregateAppOnboardingMethodTotals(onboardingFunnelData.value?.onboarding_method_trend ?? [])
})

const appOnboardingMethodTrendSeries = computed(() => {
  const trend = onboardingFunnelData.value?.onboarding_method_trend
  if (!trend || trend.length === 0)
    return []

  return [
    {
      label: t('onboarding-source-manual'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.manual) || 0,
      })),
      color: '#94a3b8',
    },
    {
      label: t('onboarding-source-cli'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.cli) || 0,
      })),
      color: '#119eff',
    },
    {
      label: t('onboarding-source-mcp'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.mcp) || 0,
      })),
      color: '#8b5cf6',
    },
    {
      label: t('onboarding-source-ai'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.ai) || 0,
      })),
      color: '#10b981',
    },
  ]
})

const appOnboardingOutcomeTotals = computed(() => {
  return aggregateAppOnboardingOutcomeTotals(onboardingFunnelData.value?.onboarding_outcome_trend ?? [])
})

const appOnboardingOutcomeTrendSeries = computed(() => {
  const trend = onboardingFunnelData.value?.onboarding_outcome_trend
  if (!trend || trend.length === 0)
    return []

  return [
    {
      label: t('onboarding-outcome-completed'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.completed) || 0,
      })),
      color: '#22c55e',
    },
    {
      label: t('onboarding-outcome-skipped'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.skipped) || 0,
      })),
      color: '#f59e0b',
    },
    {
      label: t('onboarding-outcome-switched-to-manual'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.switched_to_manual) || 0,
      })),
      color: '#f97316',
    },
    {
      label: t('onboarding-outcome-in-progress'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.in_progress) || 0,
      })),
      color: '#94a3b8',
    },
  ]
})

watch(() => adminStore.activeDateRange, () => {
  loadGlobalStatsTrend()
  loadOnboardingFunnel()
  loadEmailTypeBreakdown()
  loadCustomerCountryBreakdown()
  loadTrialPlanBreakdown()
  loadCancelledOrganizations()
}, { deep: true })

// Watch for refresh button clicks
watch(() => adminStore.refreshTrigger, () => {
  loadGlobalStatsTrend()
  loadOnboardingFunnel()
  loadEmailTypeBreakdown()
  loadCustomerCountryBreakdown()
  loadTrialPlanBreakdown()
  loadTrialOrganizations()
  loadCancelledOrganizations()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await Promise.all([loadGlobalStatsTrend(), loadOnboardingFunnel(), loadEmailTypeBreakdown(), loadCustomerCountryBreakdown(), loadTrialPlanBreakdown(), loadTrialOrganizations(), loadCancelledOrganizations()])
  isLoading.value = false

  displayStore.NavTitle = t('users-and-revenue')
})

displayStore.NavTitle = t('users-and-revenue')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <!-- Onboarding Funnel Section -->
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('onboarding-funnel') }}
            </h3>
            <p class="mb-4 text-sm text-slate-600 dark:text-slate-400">
              {{ t('onboarding-funnel-description') }}
            </p>
            <div v-if="isLoadingOnboardingFunnel" class="flex items-center justify-center h-48">
              <span class="loading loading-spinner loading-lg" />
            </div>
            <div v-else-if="onboardingFunnelStages.length > 0" class="space-y-6">
              <div class="h-72 sm:h-80">
                <AdminFunnelChart :stages="onboardingFunnelStages" :is-loading="isLoadingOnboardingFunnel" />
              </div>

              <!-- Funnel conversion summary: one grid so rates share the funnel column rhythm -->
              <div
                class="grid gap-x-2 gap-y-4 pt-4 mt-4 border-t border-gray-200 dark:border-gray-700"
                :class="onboardingFunnelConversionGridClass"
              >
                <div
                  v-for="item in onboardingFunnelConversionSummaries"
                  :key="item.key"
                  class="min-w-0 px-1 text-center"
                >
                  <p
                    class="text-xl font-bold tabular-nums sm:text-2xl"
                    :class="item.colorClass"
                  >
                    {{ formatOneDecimal(item.value) }}%
                  </p>
                  <p class="mt-1 text-[11px] leading-snug text-gray-500 break-words sm:text-xs dark:text-gray-400">
                    {{ item.label }}
                  </p>
                </div>
              </div>

              <p v-if="!onboardingFunnelData?.activation_telemetry_available" class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('activation-telemetry-unavailable') }}
              </p>
            </div>
            <div v-else class="flex items-center justify-center h-48 text-slate-400">
              {{ t('no-data-available') }}
            </div>
          </div>

          <!-- Registration Source Trend Chart -->
          <ChartCard
            :title="t('registrations-by-source')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="registrationSourceTrendSeries.length > 0"
          >
            <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('registrations-by-source-description') }}
            </p>
            <AdminStackedBarChart
              :series="registrationSourceTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
            <div data-test="registration-source-totals" class="grid grid-cols-1 gap-6 mt-6 md:grid-cols-3">
              <AdminStatsCard
                :title="t('normal-registration')"
                :value="registrationSourceTotals.normalRegistrations"
                color-class="text-blue-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('organization-invite')"
                :value="registrationSourceTotals.organizationInvites"
                color-class="text-orange-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('without-profile')"
                :value="registrationSourceTotals.withoutProfiles"
                color-class="text-slate-400"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
            </div>
          </ChartCard>

          <!-- App onboarding method chart -->
          <ChartCard
            :title="t('apps-onboarding-by-method')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="appOnboardingMethodTrendSeries.length > 0"
          >
            <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('apps-onboarding-by-method-description') }}
            </p>
            <AdminStackedBarChart
              :series="appOnboardingMethodTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
            <div data-test="app-onboarding-method-totals" class="grid grid-cols-1 gap-6 mt-6 md:grid-cols-4">
              <AdminStatsCard
                :title="t('onboarding-source-manual')"
                :value="appOnboardingMethodTotals.manual"
                color-class="text-slate-400"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('onboarding-source-cli')"
                :value="appOnboardingMethodTotals.cli"
                color-class="text-azure-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('onboarding-source-mcp')"
                :value="appOnboardingMethodTotals.mcp"
                color-class="text-violet-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('onboarding-source-ai')"
                :value="appOnboardingMethodTotals.ai"
                color-class="text-emerald-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
            </div>
          </ChartCard>

          <!-- App onboarding outcome chart -->
          <ChartCard
            :title="t('apps-onboarding-by-outcome')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="appOnboardingOutcomeTrendSeries.length > 0"
          >
            <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('apps-onboarding-by-outcome-description') }}
            </p>
            <AdminStackedBarChart
              :series="appOnboardingOutcomeTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
            <div data-test="app-onboarding-outcome-totals" class="grid grid-cols-1 gap-6 mt-6 md:grid-cols-4">
              <AdminStatsCard
                :title="t('onboarding-outcome-completed')"
                :value="appOnboardingOutcomeTotals.completed"
                color-class="text-emerald-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('onboarding-outcome-skipped')"
                :value="appOnboardingOutcomeTotals.skipped"
                color-class="text-amber-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('onboarding-outcome-switched-to-manual')"
                :value="appOnboardingOutcomeTotals.switchedToManual"
                color-class="text-orange-500"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
              <AdminStatsCard
                :title="t('onboarding-outcome-in-progress')"
                :value="appOnboardingOutcomeTotals.inProgress"
                color-class="text-slate-400"
                :is-loading="isLoadingOnboardingFunnel"
                :subtitle="t('selected-period')"
              />
            </div>
          </ChartCard>

          <!-- Onboarding Trend Chart -->
          <ChartCard
            :title="t('onboarding-trend')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="onboardingFunnelTrendSeries.length > 0"
          >
            <AdminMultiLineChart
              :series="onboardingFunnelTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
          </ChartCard>

          <!-- Invite Join Trend Chart -->
          <ChartCard
            :title="t('invite-join-trend')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="inviteJoinTrendSeries.length > 0"
          >
            <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('invite-join-trend-description') }}
            </p>
            <AdminMultiLineChart
              :series="inviteJoinTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
          </ChartCard>

          <!-- Organization Metrics Cards -->
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Total Paid Organizations
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-emerald-500">
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_total || latestGlobalStats.paying || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-emerald-500">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Subscription and/or available credits
                </p>
              </div>
            </div>
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Paid via Subscription
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-primary">
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_subscription || latestGlobalStats.paying || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-primary">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Active subscription organizations
                </p>
              </div>
            </div>
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Paid via Credits
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-accent">
                  {{ formatNumberValue(latestGlobalStats.paying_orgs_credits || 0) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-accent">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Organizations with available credits
                </p>
              </div>
            </div>

            <!-- Trial Organizations -->
            <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <div class="flex items-start justify-between mb-4">
                <div class="p-3 rounded-lg bg-warning/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-warning"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
              </div>
              <div>
                <p class="text-sm text-slate-600 dark:text-slate-400">
                  Trial Organizations
                </p>
                <p v-if="latestGlobalStats" class="mt-2 text-3xl font-bold text-warning">
                  {{ formatNumberValue(latestGlobalStats.trial) }}
                </p>
                <p v-else class="mt-2 text-3xl font-bold text-warning">
                  0
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Organizations in trial period
                </p>
              </div>
            </div>
          </div>

          <div class="space-y-6">
            <div class="flex flex-col gap-1">
              <h3 class="text-lg font-semibold">
                {{ t('admin-users-email-type-breakdown') }}
              </h3>
              <p class="text-sm text-slate-600 dark:text-slate-400">
                {{ t('admin-users-email-type-breakdown-description') }}
              </p>
            </div>

            <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
              <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
                <div class="flex items-start justify-between mb-4">
                  <div class="p-3 rounded-lg bg-primary/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-primary"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7h18M5 7l1.5 12h11L19 7M9 11h6M10 15h4" /></svg>
                  </div>
                </div>
                <div>
                  <p class="text-sm text-slate-600 dark:text-slate-400">
                    {{ t('admin-users-email-type-professional') }}
                  </p>
                  <p class="mt-2 text-3xl font-bold text-primary">
                    {{ formatNumberValue(emailTypeTotals.professional) }}
                  </p>
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {{ t('admin-users-email-type-professional-description') }}
                  </p>
                </div>
              </div>

              <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
                <div class="flex items-start justify-between mb-4">
                  <div class="p-3 rounded-lg bg-success/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-success"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  </div>
                </div>
                <div>
                  <p class="text-sm text-slate-600 dark:text-slate-400">
                    {{ t('admin-users-email-type-personal') }}
                  </p>
                  <p class="mt-2 text-3xl font-bold text-success">
                    {{ formatNumberValue(emailTypeTotals.personal) }}
                  </p>
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {{ t('admin-users-email-type-personal-description') }}
                  </p>
                </div>
              </div>

              <div class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
                <div class="flex items-start justify-between mb-4">
                  <div class="p-3 rounded-lg bg-error/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-6 h-6 stroke-current text-error"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636l-1.414 1.414M7.05 16.95l-1.414 1.414M5.636 5.636l1.414 1.414M16.95 16.95l1.414 1.414M9 12h6M12 9v6m0 6a9 9 0 100-18 9 9 0 000 18z" /></svg>
                  </div>
                </div>
                <div>
                  <p class="text-sm text-slate-600 dark:text-slate-400">
                    {{ t('admin-users-email-type-disposable') }}
                  </p>
                  <p class="mt-2 text-3xl font-bold text-error">
                    {{ formatNumberValue(emailTypeTotals.disposable) }}
                  </p>
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {{ t('admin-users-email-type-disposable-description') }}
                  </p>
                </div>
              </div>
            </div>

            <ChartCard
              :title="t('admin-users-email-type-trend')"
              :is-loading="isLoadingEmailTypeBreakdown"
              :has-data="emailTypeTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="emailTypeTrendSeries"
                :is-loading="isLoadingEmailTypeBreakdown"
              />
            </ChartCard>
          </div>

          <div class="space-y-6">
            <div class="flex flex-col gap-1">
              <h3 class="text-lg font-semibold">
                {{ t('admin-users-country-breakdown') }}
              </h3>
              <p class="text-sm text-slate-600 dark:text-slate-400">
                {{ t('admin-users-country-breakdown-description') }}
              </p>
            </div>

            <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
              <AdminStatsCard
                :title="t('admin-users-country-covered-organizations')"
                :value="customerCountryTotalOrganizations"
                color-class="text-[#119eff]"
                :is-loading="isLoadingCustomerCountryBreakdown"
                :subtitle="t('admin-users-country-covered-organizations-description')"
              />
              <AdminStatsCard
                :title="t('admin-users-country-unique-countries')"
                :value="customerCountryUniqueCountries"
                color-class="text-emerald-500"
                :is-loading="isLoadingCustomerCountryBreakdown"
                :subtitle="t('admin-users-country-unique-countries-description')"
              />
              <AdminStatsCard
                :title="t('admin-users-country-top-country')"
                :value="leadingCustomerCountry ? `${getCountryFlag(leadingCustomerCountry.country_code)} ${getCountryLabel(leadingCustomerCountry.country_code)}` : '-'"
                color-class="text-amber-500"
                :is-loading="isLoadingCustomerCountryBreakdown"
                :subtitle="leadingCustomerCountrySubtitle"
              />
            </div>

            <ChartCard
              :title="t('admin-users-country-chart')"
              :is-loading="isLoadingCustomerCountryBreakdown"
              :has-data="topCustomerCountryEntries.length > 0"
            >
              <AdminBarChart
                :key="customerCountryChartLabels.join('|')"
                :labels="customerCountryChartLabels"
                :values="customerCountryChartValues"
                :label="t('organizations')"
                value-mode="count"
              />
            </ChartCard>
          </div>

          <ChartCard
            :title="t('admin-users-trial-plan-breakdown')"
            :total="trialPlanBreakdownTotal"
            :is-loading="isLoadingTrialPlanBreakdown"
            :has-data="trialPlanBreakdownTrendSeries.length > 0"
          >
            <template #header>
              <div class="min-w-0">
                <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                  {{ t('admin-users-trial-plan-breakdown') }}
                </h2>
                <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {{ t('admin-users-trial-plan-breakdown-description') }}
                </p>
              </div>
            </template>
            <AdminMultiLineChart
              :series="trialPlanBreakdownTrendSeries"
              :is-loading="isLoadingTrialPlanBreakdown"
            />
          </ChartCard>

          <!-- Trial Organizations Table -->
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('trial-organizations-list') }}
            </h3>
            <DataTable
              :is-loading="isLoadingTrialOrganizations"
              :total="trialOrganizationsTotal"
              :current-page="trialOrganizationsCurrentPage"
              :columns="trialOrganizationsColumns"
              :element-list="trialOrganizations"
              :auto-reload="false"
              @reload="loadTrialOrganizations"
              @reset="loadTrialOrganizations"
              @update:current-page="(page: number) => { trialOrganizationsCurrentPage = page; loadTrialOrganizations() }"
            />
          </div>

          <!-- Cancelled Organizations Table -->
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('cancelled-organizations-list') }}
            </h3>
            <DataTable
              :is-loading="isLoadingCancelledOrganizations"
              :total="cancelledOrganizationsTotal"
              :current-page="cancelledOrganizationsCurrentPage"
              :columns="cancelledOrganizationsColumns"
              :element-list="cancelledOrganizations"
              :auto-reload="false"
              @reload="loadCancelledOrganizations"
              @reset="loadCancelledOrganizations"
              @update:current-page="(page: number) => { cancelledOrganizationsCurrentPage = page; loadCancelledOrganizations() }"
            />
          </div>

          <!-- Plan Distribution - Full Width -->
          <div class="grid grid-cols-1 gap-6">
            <!-- Current Distribution -->
            <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
              <h3 class="mb-4 text-lg font-semibold">
                {{ t('plan-distribution') }}
              </h3>
              <div v-if="isLoadingGlobalStatsTrend" class="flex items-center justify-center h-32">
                <span class="loading loading-spinner loading-lg" />
              </div>
              <div v-else-if="planDistributionData.length > 0" class="grid grid-cols-2 gap-4 md:grid-cols-5">
                <div v-for="plan in planDistributionData" :key="plan.label" class="flex flex-col items-center p-4 bg-gray-100 rounded-lg dark:bg-gray-700">
                  <span class="text-sm font-medium text-gray-600 dark:text-gray-400">{{ plan.label }}</span>
                  <span class="mt-2 text-2xl font-bold">{{ formatNumberValue(plan.value) }}</span>
                  <span class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ plan.percentage }}%</span>
                </div>
              </div>
              <div v-else class="flex items-center justify-center h-32 text-slate-400">
                No data available
              </div>
            </div>
          </div>

          <!-- Plan Distribution Trend Chart -->
          <div class="grid grid-cols-1 gap-6">
            <ChartCard
              :title="t('plan-distribution-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="planDistributionTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="planDistributionTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>

          <!-- Charts - 2 per row -->
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <!-- Users Trend -->
            <ChartCard
              :title="t('users-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="usersTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="usersTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Trial Extension Conversions -->
            <ChartCard
              :title="t('trial-extension-conversion-trend')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="trialExtensionTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="trialExtensionTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Daily Registrations -->
            <ChartCard
              :title="t('daily-registrations')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="registrationsTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="registrationsTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Registration to Subscription Conversion -->
            <ChartCard
              :title="t('registration-to-subscription-conversion')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="registrationToSubscriptionConversionSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="registrationToSubscriptionConversionSeries"
                :is-loading="isLoadingGlobalStatsTrend"
                value-suffix="%"
              />
            </ChartCard>

            <!-- Apps Created by Day -->
            <ChartCard
              :title="t('admin-apps-created-by-day')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="appsCreatedTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="appsCreatedTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Versions Uploaded by Day -->
            <ChartCard
              :title="t('admin-versions-uploaded-by-day')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="versionsCreatedTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="versionsCreatedTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>

            <!-- Apps with Preview QR Enabled -->
            <ChartCard
              :title="t('admin-apps-with-preview')"
              :is-loading="isLoadingGlobalStatsTrend"
              :has-data="appsWithPreviewTrendSeries.length > 0"
            >
              <AdminMultiLineChart
                :series="appsWithPreviewTrendSeries"
                :is-loading="isLoadingGlobalStatsTrend"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
