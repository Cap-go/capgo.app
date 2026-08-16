<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { PlansAnalyticsResponse } from '~/services/adminPlansAnalytics'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { buildPlansAnalyticsPresentationState, buildPlansAnalyticsSeries, createLatestRequestCoordinator, parsePlansAnalyticsResponse } from '~/services/adminPlansAnalytics'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()

const data = ref<PlansAnalyticsResponse | null>(null)
const isInitialLoading = ref(true)
const isLoadingStats = ref(false)
const requestError = ref<string | null>(null)
const authorized = ref(false)
const requestCoordinator = createLatestRequestCoordinator()

async function loadPlansAnalytics() {
  if (!authorized.value)
    return

  const requestId = requestCoordinator.begin()
  isLoadingStats.value = requestCoordinator.pendingCount > 0
  requestError.value = null
  try {
    const response: unknown = await adminStore.fetchStats('plans_analytics')
    const parsedResponse = parsePlansAnalyticsResponse(response)
    if (requestCoordinator.isLatest(requestId))
      data.value = parsedResponse
  }
  catch (error) {
    if (requestCoordinator.isLatest(requestId)) {
      console.error('[Admin Dashboard Plans] Error loading Plans analytics:', error)
      data.value = null
      requestError.value = t('plans-analytics-unavailable')
    }
  }
  finally {
    requestCoordinator.finish(requestId)
    isLoadingStats.value = requestCoordinator.pendingCount > 0
  }
}

const series = computed(() => data.value
  ? buildPlansAnalyticsSeries(data.value, t)
  : { traffic: [], visitors: [], checkoutIntent: [], checkoutVisitors: [] })

const presentation = computed(() => buildPlansAnalyticsPresentationState(data.value, requestError.value, t))
const unavailableMessage = computed(() => presentation.value.unavailableMessage)
const hasTraffic = computed(() => presentation.value.hasTraffic)
const hasVisitors = computed(() => presentation.value.hasVisitors)
const hasCheckoutIntent = computed(() => presentation.value.hasCheckoutIntent)
const hasCheckoutVisitors = computed(() => presentation.value.hasCheckoutVisitors)

watch([
  () => adminStore.activeDateRange,
  () => adminStore.refreshTrigger,
], () => {
  if (!authorized.value)
    return
  loadPlansAnalytics()
}, { deep: true })

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin Plans dashboard')
    router.push('/dashboard')
    return
  }

  authorized.value = true
  isInitialLoading.value = true
  await loadPlansAnalytics()
  isInitialLoading.value = false
  displayStore.NavTitle = t('plans-analytics-title')
})

displayStore.NavTitle = t('plans-analytics-title')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
              {{ t('plans-analytics-title') }}
            </h1>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {{ t('plans-analytics-timezone') }}
            </p>
          </div>
          <AdminFilterBar />
        </div>

        <PageLoader v-if="isInitialLoading" />

        <div v-else class="space-y-6">
          <div
            v-if="unavailableMessage"
            role="alert"
            class="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error"
          >
            {{ unavailableMessage }}
          </div>

          <div
            v-if="presentation.showPartialBillingWarning"
            role="status"
            class="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-slate-700 dark:text-slate-200"
          >
            {{ t('plans-analytics-partial-warning') }}
          </div>

          <ChartCard
            chart-id="traffic"
            :title="t('plans-analytics-traffic')"
            :is-loading="isLoadingStats"
            :has-data="hasTraffic"
            :error-message="unavailableMessage ?? undefined"
            :no-data-message="t('plans-analytics-empty')"
          >
            <template #header>
              <h2 id="plans-traffic-title" class="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
                {{ t('plans-analytics-traffic') }}
              </h2>
              <p id="plans-traffic-description" class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('plans-analytics-traffic-description') }}
              </p>
            </template>
            <div role="group" aria-labelledby="plans-traffic-title" aria-describedby="plans-traffic-description" class="h-full">
              <AdminMultiLineChart :series="series.traffic" :is-loading="isLoadingStats" />
              <table class="sr-only">
                <caption>{{ t('plans-analytics-traffic-description') }}</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('date') }}
                    </th><th v-for="item in series.traffic" :key="item.label" scope="col">
                      {{ item.label }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(point, index) in series.traffic[0]?.data ?? []" :key="point.date">
                    <th scope="row">
                      {{ point.date }}
                    </th><td v-for="item in series.traffic" :key="item.label">
                      {{ item.data[index]?.value ?? 0 }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ChartCard>

          <ChartCard
            chart-id="plan-page-visitors"
            :title="t('plans-analytics-who-opened')"
            :is-loading="isLoadingStats"
            :has-data="hasVisitors"
            :error-message="unavailableMessage ?? undefined"
            :no-data-message="t('plans-analytics-empty')"
          >
            <template #header>
              <h2 id="plans-visitors-title" class="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
                {{ t('plans-analytics-who-opened') }}
              </h2>
              <p id="plans-visitors-description" class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('plans-analytics-who-opened-description') }}
              </p>
            </template>
            <div role="group" aria-labelledby="plans-visitors-title" aria-describedby="plans-visitors-description" class="h-full">
              <AdminStackedBarChart :series="series.visitors" :is-loading="isLoadingStats" accessible-borders />
              <table class="sr-only">
                <caption>{{ t('plans-analytics-who-opened-description') }}</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('date') }}
                    </th><th v-for="item in series.visitors" :key="item.label" scope="col">
                      {{ item.label }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(point, index) in series.visitors[0]?.data ?? []" :key="point.date">
                    <th scope="row">
                      {{ point.date }}
                    </th><td v-for="item in series.visitors" :key="item.label">
                      {{ item.data[index]?.value ?? 0 }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ChartCard>

          <ChartCard
            chart-id="checkout-intent"
            :title="t('plans-analytics-checkout-intent')"
            :is-loading="isLoadingStats"
            :has-data="hasCheckoutIntent"
            :error-message="unavailableMessage ?? undefined"
            :no-data-message="t('plans-analytics-empty')"
          >
            <template #header>
              <h2 id="plans-checkout-intent-title" class="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
                {{ t('plans-analytics-checkout-intent') }}
              </h2>
              <p id="plans-checkout-intent-description" class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('plans-analytics-checkout-intent-description') }}
              </p>
            </template>
            <div role="group" aria-labelledby="plans-checkout-intent-title" aria-describedby="plans-checkout-intent-description" class="h-full">
              <AdminStackedBarChart :series="series.checkoutIntent" :is-loading="isLoadingStats" accessible-borders />
              <table class="sr-only">
                <caption>{{ t('plans-analytics-checkout-intent-description') }}</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('date') }}
                    </th><th v-for="item in series.checkoutIntent" :key="item.label" scope="col">
                      {{ item.label }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(point, index) in series.checkoutIntent[0]?.data ?? []" :key="point.date">
                    <th scope="row">
                      {{ point.date }}
                    </th><td v-for="item in series.checkoutIntent" :key="item.label">
                      {{ item.data[index]?.value ?? 0 }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ChartCard>

          <ChartCard
            chart-id="checkout-visitors"
            :title="t('plans-analytics-who-opened-checkout')"
            :is-loading="isLoadingStats"
            :has-data="hasCheckoutVisitors"
            :error-message="unavailableMessage ?? undefined"
            :no-data-message="t('plans-analytics-empty')"
          >
            <template #header>
              <h2 id="plans-checkout-visitors-title" class="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
                {{ t('plans-analytics-who-opened-checkout') }}
              </h2>
              <p id="plans-checkout-visitors-description" class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {{ t('plans-analytics-who-opened-checkout-description') }}
              </p>
            </template>
            <div role="group" aria-labelledby="plans-checkout-visitors-title" aria-describedby="plans-checkout-visitors-description" class="h-full">
              <AdminStackedBarChart :series="series.checkoutVisitors" :is-loading="isLoadingStats" accessible-borders />
              <table class="sr-only">
                <caption>{{ t('plans-analytics-who-opened-checkout-description') }}</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('date') }}
                    </th><th v-for="item in series.checkoutVisitors" :key="item.label" scope="col">
                      {{ item.label }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(point, index) in series.checkoutVisitors[0]?.data ?? []" :key="point.date">
                    <th scope="row">
                      {{ point.date }}
                    </th><td v-for="item in series.checkoutVisitors" :key="item.label">
                      {{ item.data[index]?.value ?? 0 }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ChartCard>

          <ChartCard chart-id="checkout-completion" :title="t('plans-analytics-checkout-completion')" :has-data="true">
            <template #header>
              <h2 class="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
                {{ t('plans-analytics-checkout-completion') }}
              </h2>
            </template>
            <div class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <p class="max-w-2xl text-sm text-slate-600 dark:text-slate-300">
                {{ t('plans-analytics-checkout-completion-description') }}
              </p>
              <a
                href="https://github.com/Cap-go/capgo.app/blob/main/docs/admin/plans-checkout-completion.md"
                target="_blank"
                rel="noopener noreferrer"
                class="font-medium text-primary underline underline-offset-4 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {{ t('plans-analytics-checkout-completion-link') }}
              </a>
            </div>
          </ChartCard>
        </div>
      </div>
    </div>
  </div>
</template>
