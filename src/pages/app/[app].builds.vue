<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import BuildChartControls from '~/components/dashboard/BuildChartControls.vue'
import BuildStatsCard from '~/components/dashboard/BuildStatsCard.vue'
import BuildTimeCard from '~/components/dashboard/BuildTimeCard.vue'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const id = ref('')
const route = useRoute('/app/[app].builds')
const lastPath = ref('')
const isLoading = ref(false)
const supabase = useSupabase()
const displayStore = useDisplayStore()
const app = ref<Database['public']['Tables']['apps']['Row']>()
const showingBuildSteps = ref(false)

// Build chart controls + window state
const useBillingPeriod = ref(route.query.billingPeriod === 'true')
const showCumulative = ref(route.query.cumulative === 'true')
const reloadTrigger = ref(0)
const accumulated = computed(() => useBillingPeriod.value && showCumulative.value)

// Reload-button spinner reflects either chart card fetching.
const statsLoading = ref(false)
const timeLoading = ref(false)
const chartsRefreshing = computed(() => statsLoading.value || timeLoading.value)

async function loadAppInfo() {
  try {
    const { data: dataApp } = await supabase
      .from('apps')
      .select()
      .eq('app_id', id.value)
      .single()
    app.value = dataApp || app.value
  }
  catch (error) {
    console.error(error)
  }
}

async function refreshData() {
  isLoading.value = true
  try {
    await loadAppInfo()
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}

watchEffect(async () => {
  if (route.params.app && lastPath.value !== route.path) {
    lastPath.value = route.path
    id.value = route.params.app as string
    await refreshData()
    displayStore.NavTitle = ''
    displayStore.defaultBack = '/apps'
  }
})
</script>

<template>
  <div>
    <div v-if="app || isLoading">
      <div class="mt-0 md:mt-8">
        <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
          <div v-if="!showingBuildSteps" class="mb-6">
            <BuildChartControls
              v-model:use-billing-period="useBillingPeriod"
              v-model:show-cumulative="showCumulative"
              :is-refreshing="chartsRefreshing"
              class="mb-4"
              @reload="reloadTrigger++"
            />
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <BuildStatsCard
                :app-id="id"
                :use-billing-period="useBillingPeriod"
                :accumulated="accumulated"
                :reload-trigger="reloadTrigger"
                class="sm:col-span-1"
                @update:loading="statsLoading = $event"
              />
              <BuildTimeCard
                :app-id="id"
                :use-billing-period="useBillingPeriod"
                :accumulated="accumulated"
                :reload-trigger="reloadTrigger"
                class="sm:col-span-1"
                @update:loading="timeLoading = $event"
              />
            </div>
          </div>

          <BuildTable :app-id="id" @update:showing-steps="showingBuildSteps = $event" />
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('app-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('app-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="$router.push(`/apps`)">
        {{ t('back-to-apps') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
