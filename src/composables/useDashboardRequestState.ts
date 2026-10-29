import type { MaybeRefOrGetter } from 'vue'
import { computed, onScopeDispose, ref, toValue, watch } from 'vue'

export function useDashboardRequestState(scope: MaybeRefOrGetter<string>) {
  const pending = ref(true)
  const loadedScope = ref<string>()
  const error = ref(false)
  let generation = 0

  watch(() => toValue(scope), () => {
    generation++
    pending.value = true
    loadedScope.value = undefined
    error.value = false
  }, { flush: 'sync' })
  onScopeDispose(() => generation++)

  function start() {
    const requestGeneration = ++generation
    const requestScope = toValue(scope)
    const isInitial = loadedScope.value !== requestScope
    const isCurrent = () => generation === requestGeneration && toValue(scope) === requestScope
    let failed = false
    pending.value = true
    error.value = false

    return {
      isInitial,
      isCurrent,
      fail() {
        failed = true
        if (isCurrent())
          error.value = true
      },
      finish() {
        if (!isCurrent())
          return
        pending.value = false
        if (!failed)
          loadedScope.value = requestScope
      },
    }
  }

  const hasLoaded = computed(() => loadedScope.value === toValue(scope))
  return {
    start,
    hasLoaded,
    error,
    isLoading: computed(() => pending.value && !hasLoaded.value),
    isRefreshing: computed(() => pending.value && hasLoaded.value),
  }
}
