import type { MaybeRefOrGetter } from 'vue'
import { computed, onBeforeUnmount, onMounted, ref, toValue, watch } from 'vue'
import { parseAppOnboarding } from '~/services/appOnboarding'
import { invokeCapgoApi } from '~/services/capgoApi'

interface ProgressResponse {
  onboarding: unknown
  hasChannel?: boolean
  checkErrors: string[]
}

export function useAppOnboardingCliProgress(appId: MaybeRefOrGetter<string>, initialOnboarding: MaybeRefOrGetter<unknown>) {
  const reportedOnboarding = ref(parseAppOnboarding(toValue(initialOnboarding)))
  const hasChannel = ref<boolean | null>(null)
  const onboarding = computed(() => {
    const reported = reportedOnboarding.value
    if (hasChannel.value === null)
      return reported
    const steps = { ...reported.steps }
    if (hasChannel.value)
      steps.add_channel = { ...steps.add_channel, status: 'done' }
    else
      delete steps.add_channel
    return { ...reported, steps }
  })
  const refreshError = ref(false)
  const isTerminal = computed(() => onboarding.value.outcome === 'completed' || onboarding.value.outcome === 'skipped')
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let refreshing = false
  let mounted = false
  let N = 0

  function stopPolling() {
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  function startPolling() {
    if (pollTimer === undefined && mounted)
      pollTimer = setInterval(() => void refreshProgress(false), 2000)
  }

  async function refreshProgress(initial: boolean) {
    if (refreshing)
      return
    const requestedGeneration = generation
    const requestedAppId = toValue(appId)
    refreshing = true
    try {
      const { data, error } = await invokeCapgoApi<ProgressResponse>('private/onboarding_progress', {
        body: { appId: requestedAppId, N: N++, initial },
        retries: 0,
      })
      if (requestedGeneration !== generation || requestedAppId !== toValue(appId))
        return
      refreshError.value = !!error || !!data?.checkErrors?.length
      if (data) {
        reportedOnboarding.value = parseAppOnboarding(data.onboarding)
        if (typeof data.hasChannel === 'boolean')
          hasChannel.value = data.hasChannel
      }
      if (isTerminal.value)
        stopPolling()
    }
    catch {
      if (requestedGeneration === generation)
        refreshError.value = true
    }
    finally {
      if (requestedGeneration === generation)
        refreshing = false
    }
  }

  const refreshOnboarding = () => refreshProgress(true)
  watch(() => toValue(initialOnboarding), value => reportedOnboarding.value = parseAppOnboarding(value))
  watch(() => toValue(appId), () => {
    generation += 1
    refreshing = false
    N = 0
    refreshError.value = false
    hasChannel.value = null
    reportedOnboarding.value = parseAppOnboarding(toValue(initialOnboarding))
    stopPolling()
    if (mounted) {
      void refreshOnboarding()
      if (!isTerminal.value)
        startPolling()
    }
  })
  watch(isTerminal, terminal => terminal ? stopPolling() : startPolling())
  onMounted(() => {
    mounted = true
    void refreshOnboarding()
    if (!isTerminal.value)
      startPolling()
  })
  onBeforeUnmount(() => {
    mounted = false
    generation += 1
    stopPolling()
  })
  return { onboarding, refreshError, refreshOnboarding }
}
