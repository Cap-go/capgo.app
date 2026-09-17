import type { Ref } from 'vue'
import type { OnboardingChannelAnimationStage, OnboardingChannelEvent, OnboardingChannelEventProperties } from '~/utils/onboardingChannelAnalytics'
import { gsap } from 'gsap'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { createOnboardingChannelAnimationTracker } from '~/utils/onboardingChannelAnalytics'

type AnimationTrigger = 'automatic' | 'replay' | 'resize'

interface UseOnboardingChannelAnimationOptions {
  beforeReplay?: () => void
  buildTimeline: () => gsap.core.Timeline | null
  emitAnalytics: (event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) => void
  onBack?: () => void
  onContinue: () => void
  rebuildOnReplay?: boolean
  root: Ref<HTMLElement | null>
  showFinalState: () => void
  stage: OnboardingChannelAnimationStage
}

export function useOnboardingChannelAnimation(options: UseOnboardingChannelAnimationOptions) {
  const reducedMotion = ref(false)
  let timeline: gsap.core.Timeline | null = null
  let media: gsap.MatchMedia | null = null
  let resizeObserver: ResizeObserver | null = null
  let resizeAnimationFrame: number | null = null
  const analytics = createOnboardingChannelAnimationTracker({
    emit: options.emitAnalytics,
    stage: options.stage,
  })

  function progressSource(animation: gsap.core.Timeline) {
    return {
      durationMs: () => animation.duration() * 1_000,
      progress: () => animation.progress(),
    }
  }

  function playAnimation(animation: gsap.core.Timeline, trigger: AnimationTrigger) {
    const source = progressSource(animation)
    const replacedAfterResize = trigger === 'resize' && analytics.replaceProgressSource(source)
    if (!replacedAfterResize)
      analytics.start(trigger === 'replay' ? 'replay' : 'automatic', source)
    animation.eventCallback('onComplete', analytics.complete)
    animation.play(0)
  }

  function createAnimation(trigger: AnimationTrigger = 'automatic') {
    timeline?.kill()
    media?.revert()
    timeline = null
    media = gsap.matchMedia()

    media.add('(prefers-reduced-motion: reduce)', () => {
      reducedMotion.value = true
      options.showFinalState()
      analytics.showReducedMotion()
    })

    media.add('(prefers-reduced-motion: no-preference)', () => {
      reducedMotion.value = false
      timeline = options.buildTimeline()
      if (!timeline) {
        analytics.unavailable()
        return
      }
      playAnimation(timeline, trigger)

      return () => {
        timeline?.kill()
        timeline = null
      }
    })
  }

  function refreshAnimationAfterResize() {
    if (resizeAnimationFrame !== null)
      window.cancelAnimationFrame(resizeAnimationFrame)
    resizeAnimationFrame = window.requestAnimationFrame(() => {
      resizeAnimationFrame = null
      createAnimation('resize')
    })
  }

  function replay() {
    analytics.replayRequested()
    if (reducedMotion.value) {
      options.showFinalState()
      analytics.showReducedMotion()
      return
    }

    options.beforeReplay?.()
    if (options.rebuildOnReplay === false && timeline) {
      playAnimation(timeline, 'replay')
      return
    }
    createAnimation('replay')
  }

  function goBack() {
    analytics.leave('back')
    options.onBack?.()
  }

  function continueOnboarding() {
    analytics.leave('continue')
    options.onContinue()
  }

  onMounted(async () => {
    await nextTick()
    createAnimation()
    if (options.root.value) {
      resizeObserver = new ResizeObserver(refreshAnimationAfterResize)
      resizeObserver.observe(options.root.value)
    }
  })

  onBeforeUnmount(() => {
    analytics.dispose()
    resizeObserver?.disconnect()
    if (resizeAnimationFrame !== null)
      window.cancelAnimationFrame(resizeAnimationFrame)
    timeline?.kill()
    media?.revert()
    timeline = null
    media = null
  })

  return {
    continueOnboarding,
    goBack,
    reducedMotion,
    replay,
  }
}
