import type { MaybeRefOrGetter } from 'vue'
import { computed, onBeforeUnmount, onMounted, ref, toValue, watch } from 'vue'
import { getAppOnboardingStepIds, hasSupportedOtaTodoList, parseAppOnboarding } from '~/services/appOnboarding'
import { invokeCapgoApi } from '~/services/capgoApi'
import { FunctionsHttpError } from '~/services/consoleClient'
import { withUsageProvenSteps } from '~/utils/appOnboardingProgress'
import { hasDualOnboardingChecklists } from '~/utils/dualOnboardingChecklists'

/** First poll delay, and the delay again after any progress. */
export const CLI_PROGRESS_POLL_BASE_MS = 2_000
/** Poll every CLI_PROGRESS_POLL_BASE_MS for this long after the last progress, then back off. */
export const CLI_PROGRESS_POLL_FAST_PHASE_MS = 2 * 60_000
/** Longest delay between polls once nothing changes. */
export const CLI_PROGRESS_POLL_MAX_MS = 30_000
const CLI_PROGRESS_POLL_BACKOFF = 1.5
/** Stop polling after this long without progress; a manual refresh or the tab becoming visible again restarts it. */
export const CLI_PROGRESS_POLL_MAX_IDLE_MS = 30 * 60_000

function isDocumentHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

interface ProgressResponse {
  onboarding: unknown
  hasChannel?: boolean
  checkErrors: string[]
}

export function useAppOnboardingCliProgress(appId: MaybeRefOrGetter<string>, initialOnboarding: MaybeRefOrGetter<unknown>, active: MaybeRefOrGetter<boolean> = true) {
  const rawOnboarding = ref(toValue(initialOnboarding))
  const reportedOnboarding = ref(parseAppOnboarding(toValue(initialOnboarding)))
  const hasChannel = ref<boolean | null>(null)
  const onboarding = computed(() => {
    const reported = reportedOnboarding.value
    const steps = { ...reported.steps }
    if (hasChannel.value)
      steps.add_channel = { ...steps.add_channel, status: 'done' }
    else if (hasChannel.value === false)
      delete steps.add_channel
    // Usage applies last, matching the nav: a channel deleted after a successful
    // OTA install does not reopen onboarding.
    return withUsageProvenSteps({ ...reported, steps }, rawOnboarding.value)
  })
  const refreshError = ref(false)
  const isTerminal = computed(() => {
    const stepsDone = hasSupportedOtaTodoList(onboarding.value)
      && getAppOnboardingStepIds(onboarding.value.todo_list_version, onboarding.value.ota_todo_list_version).every(id => ['done', 'skipped'].includes(onboarding.value.steps[id]?.status ?? 'pending'))
    if (hasDualOnboardingChecklists(rawOnboarding.value))
      return stepsDone
    return stepsDone || onboarding.value.outcome === 'completed' || onboarding.value.outcome === 'skipped'
  })
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let refreshing = false
  let mounted = false
  let accessRevoked = false
  let N = 0
  // Polling backs off while nothing changes, pauses while the tab is hidden and
  // ends after CLI_PROGRESS_POLL_MAX_IDLE_MS without progress.
  let pollingWanted = false
  let pollDelay = CLI_PROGRESS_POLL_BASE_MS
  let lastProgressAt = 0
  let lastSnapshot: string | undefined

  function resetBackoff() {
    pollDelay = CLI_PROGRESS_POLL_BASE_MS
    lastProgressAt = Date.now()
  }

  function canPoll() {
    return mounted && !accessRevoked && toValue(active) && !isTerminal.value
  }

  function clearPollTimer() {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }

  function stopPolling() {
    pollingWanted = false
    clearPollTimer()
  }

  function scheduleNextPoll() {
    if (pollTimer !== undefined || !pollingWanted || !canPoll() || isDocumentHidden())
      return
    if (Date.now() - lastProgressAt >= CLI_PROGRESS_POLL_MAX_IDLE_MS) {
      stopPolling()
      return
    }
    pollTimer = setTimeout(async () => {
      pollTimer = undefined
      // Back off once the fast phase is over; a poll that sees progress resets the delay.
      if (Date.now() - lastProgressAt >= CLI_PROGRESS_POLL_FAST_PHASE_MS)
        pollDelay = Math.min(Math.round(pollDelay * CLI_PROGRESS_POLL_BACKOFF), CLI_PROGRESS_POLL_MAX_MS)
      await refreshProgress(false)
      scheduleNextPoll()
    }, pollDelay)
  }

  // Progress seen: poll at the base delay again, replacing a backed-off timer.
  function pollSoon() {
    resetBackoff()
    if (pollTimer !== undefined) {
      clearPollTimer()
      scheduleNextPoll()
    }
  }

  function startPolling() {
    if (!canPoll())
      return
    if (!pollingWanted) {
      pollingWanted = true
      resetBackoff()
    }
    scheduleNextPoll()
  }

  function onVisibilityChange() {
    if (isDocumentHidden()) {
      // Paused, not stopped: the next visible tab polls right away.
      clearPollTimer()
      return
    }
    if (!canPoll())
      return
    void refreshProgress(false)
    pollingWanted = false
    startPolling()
  }

  async function refreshProgress(initial: boolean) {
    if (refreshing || !toValue(active))
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
      // No access to (or no longer existing) app: retrying every 2s can never
      // succeed, so stop polling until the app changes or a manual refresh works.
      if (error instanceof FunctionsHttpError && [403, 404].includes(error.context?.status)) {
        accessRevoked = true
        stopPolling()
        return
      }
      if (!error && accessRevoked) {
        accessRevoked = false
        if (!isTerminal.value)
          startPolling()
      }
      if (data) {
        const snapshot = JSON.stringify([data.onboarding, data.hasChannel ?? null])
        if (snapshot !== lastSnapshot) {
          if (lastSnapshot !== undefined)
            pollSoon()
          lastSnapshot = snapshot
        }
        rawOnboarding.value = data.onboarding
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

  const refreshOnboarding = () => {
    // A manual refresh also restarts polling that ended after the idle limit.
    if (mounted && !pollingWanted && canPoll())
      startPolling()
    return refreshProgress(true)
  }
  // Apply a snapshot returned by a write and drop any older in-flight poll.
  function applyOnboarding(value: unknown) {
    generation += 1
    refreshing = false
    pollSoon()
    rawOnboarding.value = value
    reportedOnboarding.value = parseAppOnboarding(value)
  }
  watch(() => toValue(initialOnboarding), (value) => {
    rawOnboarding.value = value
    reportedOnboarding.value = parseAppOnboarding(value)
  })
  watch(() => toValue(appId), () => {
    generation += 1
    refreshing = false
    accessRevoked = false
    lastSnapshot = undefined
    N = 0
    refreshError.value = false
    hasChannel.value = null
    rawOnboarding.value = toValue(initialOnboarding)
    reportedOnboarding.value = parseAppOnboarding(toValue(initialOnboarding))
    stopPolling()
    if (mounted) {
      void refreshOnboarding()
      if (!isTerminal.value)
        startPolling()
    }
  })
  watch(isTerminal, terminal => terminal ? stopPolling() : startPolling())
  watch(() => toValue(active), (enabled) => {
    if (!enabled) {
      stopPolling()
    }
    else if (mounted) {
      void refreshOnboarding()
      if (!isTerminal.value)
        startPolling()
    }
  })
  onMounted(() => {
    mounted = true
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibilityChange)
    void refreshOnboarding()
    if (!isTerminal.value)
      startPolling()
  })
  onBeforeUnmount(() => {
    mounted = false
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibilityChange)
    generation += 1
    stopPolling()
  })
  return { onboarding, rawOnboarding, hasChannel, refreshError, refreshOnboarding, applyOnboarding }
}
