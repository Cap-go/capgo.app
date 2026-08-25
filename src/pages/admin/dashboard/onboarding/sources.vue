<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { OnboardingFunnelData } from '~/services/adminStatsTypes'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminBarChart from '~/components/admin/AdminBarChart.vue'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { aggregateAppOnboardingMethodTotals, aggregateAppOnboardingOutcomeTotals } from '~/services/adminAppOnboarding'
import { aggregateRegistrationSourceTotals } from '~/services/adminRegistrationSources'
import { formatNumberValue, formatOneDecimal } from '~/services/formatLocale'
import { getEmoji } from '~/services/i18n'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { locale, t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)

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

const onboardingFunnelData = ref<OnboardingFunnelData | null>(null)
const isLoadingOnboardingFunnel = ref(false)
const emailTypeBreakdown = ref<EmailTypeBreakdown | null>(null)
const isLoadingEmailTypeBreakdown = ref(false)
const customerCountryBreakdown = ref<CustomerCountryBreakdown | null>(null)
const isLoadingCustomerCountryBreakdown = ref(false)
let loadOnboardingFunnelSequence = 0
let loadEmailTypeBreakdownSequence = 0
let loadCustomerCountryBreakdownSequence = 0

async function loadOnboardingFunnel() {
  const sequence = ++loadOnboardingFunnelSequence
  isLoadingOnboardingFunnel.value = true
  try {
    const data = await adminStore.fetchStats('onboarding_funnel')
    if (sequence !== loadOnboardingFunnelSequence)
      return
    onboardingFunnelData.value = data || null
  }
  catch (error) {
    if (sequence !== loadOnboardingFunnelSequence)
      return
    console.error('[Admin Dashboard Onboarding Sources] Error loading onboarding funnel:', error)
    onboardingFunnelData.value = null
  }
  finally {
    if (sequence === loadOnboardingFunnelSequence)
      isLoadingOnboardingFunnel.value = false
  }
}

async function loadEmailTypeBreakdown() {
  const sequence = ++loadEmailTypeBreakdownSequence
  isLoadingEmailTypeBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('email_type_breakdown')
    if (sequence !== loadEmailTypeBreakdownSequence)
      return
    emailTypeBreakdown.value = data as EmailTypeBreakdown
  }
  catch (error) {
    if (sequence !== loadEmailTypeBreakdownSequence)
      return
    console.error('[Admin Dashboard Onboarding Sources] Error loading email type breakdown:', error)
    emailTypeBreakdown.value = null
  }
  finally {
    if (sequence === loadEmailTypeBreakdownSequence)
      isLoadingEmailTypeBreakdown.value = false
  }
}

async function loadCustomerCountryBreakdown() {
  const sequence = ++loadCustomerCountryBreakdownSequence
  isLoadingCustomerCountryBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('customer_country_breakdown')
    if (sequence !== loadCustomerCountryBreakdownSequence)
      return
    customerCountryBreakdown.value = data as CustomerCountryBreakdown
  }
  catch (error) {
    if (sequence !== loadCustomerCountryBreakdownSequence)
      return
    console.error('[Admin Dashboard Onboarding Sources] Error loading customer country breakdown:', error)
    customerCountryBreakdown.value = null
  }
  finally {
    if (sequence === loadCustomerCountryBreakdownSequence)
      isLoadingCustomerCountryBreakdown.value = false
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

const registrationSourceTotals = computed(() => {
  return aggregateRegistrationSourceTotals(onboardingFunnelData.value?.registration_source_trend ?? [])
})

const startingOutTrendSeries = computed(() => {
  const trend = onboardingFunnelData.value?.starting_out_trend ?? []
  return [
    {
      label: t('starting-out-no-users'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.starting_out_true) || 0,
      })),
      color: '#3b82f6',
    },
    {
      label: t('starting-out-existing-users'),
      data: trend.map(item => ({
        date: item.date,
        value: Number(item.starting_out_false) || 0,
      })),
      color: '#f97316',
    },
  ]
})
const hasStartingOutTrendData = computed(() => (
  onboardingFunnelData.value?.starting_out_trend?.some(item => (
    (Number(item.starting_out_true) || 0) + (Number(item.starting_out_false) || 0) > 0
  )) ?? false
))

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

const hasAppOnboardingMethodTrendData = computed(() => (
  onboardingFunnelData.value?.onboarding_method_trend?.some(item => (
    (Number(item.manual) || 0)
    + (Number(item.cli) || 0)
    + (Number(item.mcp) || 0)
    + (Number(item.ai) || 0) > 0
  )) ?? false
))

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

const hasAppOnboardingOutcomeTrendData = computed(() => (
  onboardingFunnelData.value?.onboarding_outcome_trend?.some(item => (
    (Number(item.completed) || 0)
    + (Number(item.skipped) || 0)
    + (Number(item.switched_to_manual) || 0)
    + (Number(item.in_progress) || 0) > 0
  )) ?? false
))

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (!mainStore.isAdmin)
      return
    loadOnboardingFunnel()
    loadEmailTypeBreakdown()
    loadCustomerCountryBreakdown()
  },
  { deep: true },
)

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await Promise.all([loadOnboardingFunnel(), loadEmailTypeBreakdown(), loadCustomerCountryBreakdown()])
  isLoading.value = false

  displayStore.NavTitle = t('admin-onboarding-sources')
})

displayStore.NavTitle = t('admin-onboarding-sources')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <ChartCard
            chart-id="organizations-by-starting-out"
            :title="t('organizations-by-starting-out')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="hasStartingOutTrendData"
          >
            <p class="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {{ t('organizations-by-starting-out-description') }}
            </p>
            <AdminStackedBarChart
              :series="startingOutTrendSeries"
              :is-loading="isLoadingOnboardingFunnel"
            />
          </ChartCard>

          <!-- Registration Source Trend Chart -->
          <ChartCard
            chart-id="registrations-by-source"
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

          <ChartCard
            chart-id="apps-onboarding-by-method"
            :title="t('apps-onboarding-by-method')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="hasAppOnboardingMethodTrendData"
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

          <ChartCard
            chart-id="apps-onboarding-by-outcome"
            :title="t('apps-onboarding-by-outcome')"
            :is-loading="isLoadingOnboardingFunnel"
            :has-data="hasAppOnboardingOutcomeTrendData"
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
        </div>
      </div>
    </div>
  </div>
</template>
