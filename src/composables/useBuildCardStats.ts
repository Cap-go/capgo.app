import type { Ref } from 'vue'
import type { BuildChartWindow } from '~/services/buildCharts'
import { onMounted, ref, watch } from 'vue'
import { getBuildChartWindow } from '~/services/buildCharts'
import { useOrganizationStore } from '~/stores/organization'

interface BuildCardProps {
  appId: string
  orgId?: string
  useBillingPeriod: boolean
  reloadTrigger: number
}

// Shared data lifecycle for the build chart cards: resolves the target org +
// billing window, guards overlapping requests, enforces a minimum spinner, and
// re-fetches on app / mode / org / reload changes. The card supplies how to load
// and what an empty result looks like.
export function useBuildCardStats<R>(
  props: BuildCardProps,
  emit: (event: 'update:loading', value: boolean) => void,
  options: { empty: () => R, load: (window: BuildChartWindow) => Promise<R> },
) {
  const organizationStore = useOrganizationStore()
  let latestRequestToken = 0
  const isLoading = ref(true)
  const result = ref(options.empty()) as Ref<R>

  watch(isLoading, value => emit('update:loading', value), { immediate: true })

  async function calculateStats() {
    const startTime = Date.now()
    const requestToken = ++latestRequestToken
    isLoading.value = true

    try {
      if (!organizationStore.currentOrganization)
        await organizationStore.awaitInitialLoad()

      const targetOrg = (props.orgId ? organizationStore.organizations.find(org => org.gid === props.orgId) : organizationStore.getOrgByAppId(props.appId))
        ?? organizationStore.currentOrganization
      const window = getBuildChartWindow(props.useBillingPeriod, targetOrg?.subscription_start)
      const loaded = await options.load(window)

      if (requestToken !== latestRequestToken)
        return
      result.value = loaded
    }
    catch (error) {
      console.error('Error fetching build chart data:', error)
      if (requestToken === latestRequestToken)
        result.value = options.empty()
    }
    finally {
      if (requestToken === latestRequestToken) {
        const elapsed = Date.now() - startTime
        if (elapsed < 300)
          await new Promise(resolve => setTimeout(resolve, 300 - elapsed))
        isLoading.value = false
      }
    }
  }

  watch(() => props.appId, calculateStats)
  watch(() => props.orgId, calculateStats)
  watch(() => props.useBillingPeriod, calculateStats)
  watch(() => organizationStore.currentOrganization?.gid, (newOrgId, oldOrgId) => {
    if (newOrgId && oldOrgId && newOrgId !== oldOrgId)
      calculateStats()
  })
  watch(() => props.reloadTrigger, (value) => {
    if (value > 0)
      calculateStats()
  })
  onMounted(calculateStats)

  return { isLoading, result }
}
