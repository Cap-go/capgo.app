import type { Ref } from 'vue'
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useMainStore } from '~/stores/main'

/**
 * Shared admin hub reload wiring: date-range + refresh trigger, gated by isAdmin.
 */
export function useAdminStatsReload(load: () => void | Promise<void>) {
  const adminStore = useAdminDashboardStore()
  const mainStore = useMainStore()

  watch(
    [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
    () => {
      if (!mainStore.isAdmin)
        return
      void load()
    },
    { deep: true },
  )
}

export async function ensureAdminOrRedirect(
  logLabel: string,
  isLoading?: Ref<boolean>,
  load?: () => void | Promise<void>,
) {
  const mainStore = useMainStore()
  const router = useRouter()
  if (!mainStore.isAdmin) {
    console.error(logLabel)
    await router.push('/dashboard')
    return false
  }
  if (isLoading)
    isLoading.value = true
  if (load)
    await load()
  if (isLoading)
    isLoading.value = false
  return true
}
