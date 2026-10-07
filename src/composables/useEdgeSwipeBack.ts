import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted } from 'vue'

// Width of the left screen edge that starts a back swipe, like UIKit's
// interactive pop gesture.
const EDGE_WIDTH = 24
const COMPLETE_RATIO = 0.35
const COMPLETE_VELOCITY = 0.5
const SETTLE_MS = 220

interface EdgeSwipeBackOptions {
  enabled: boolean
  canGoBack: () => boolean
  /** Navigate back. Resolve once the previous page is rendered. */
  onBack: () => Promise<unknown>
}

/**
 * iOS-style interactive edge swipe back for the WebView content. The page
 * follows the finger from the left edge, and releasing past the threshold
 * slides it out and pops the router history.
 */
export function useEdgeSwipeBack(target: Ref<HTMLElement | null | undefined>, options: EdgeSwipeBackOptions) {
  let tracking = false
  let dragging = false
  let startX = 0
  let startY = 0
  let startTime = 0
  let deltaX = 0
  let settleTimer: number | undefined

  function clearSettleTimer() {
    if (settleTimer !== undefined) {
      window.clearTimeout(settleTimer)
      settleTimer = undefined
    }
  }

  function setStyle(el: HTMLElement, transform: string, transition: string) {
    el.style.transition = transition
    el.style.transform = transform
    el.style.boxShadow = transform ? '-12px 0 32px rgba(0, 0, 0, 0.28)' : ''
    el.style.willChange = transform ? 'transform' : ''
  }

  function reset(el: HTMLElement) {
    setStyle(el, '', '')
  }

  function onTouchStart(event: TouchEvent) {
    tracking = false
    dragging = false
    const touch = event.touches[0]
    if (event.touches.length !== 1 || !touch || touch.clientX > EDGE_WIDTH || !options.canGoBack())
      return
    // A new gesture owns the transform: a pending settle reset must not snap it back.
    clearSettleTimer()
    tracking = true
    startX = touch.clientX
    startY = touch.clientY
    startTime = performance.now()
    deltaX = 0
  }

  function onTouchMove(event: TouchEvent) {
    const el = target.value
    const touch = event.touches[0]
    if (!tracking || !el || !touch)
      return

    deltaX = touch.clientX - startX
    const deltaY = touch.clientY - startY

    if (!dragging) {
      // Vertical scroll wins until the finger clearly moves sideways.
      if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
        tracking = false
        return
      }
      if (deltaX < 8)
        return
      dragging = true
    }

    event.preventDefault()
    setStyle(el, `translate3d(${Math.max(0, deltaX)}px, 0, 0)`, 'none')
  }

  function settleBack(el: HTMLElement) {
    setStyle(el, 'translate3d(0, 0, 0)', `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`)
    clearSettleTimer()
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined
      reset(el)
    }, SETTLE_MS)
  }

  // An interrupted gesture (system takeover, incoming call) never navigates.
  function onTouchCancel() {
    const el = target.value
    const wasDragging = dragging
    tracking = false
    dragging = false
    if (el && wasDragging)
      settleBack(el)
  }

  async function onTouchEnd() {
    const el = target.value
    const wasDragging = dragging
    tracking = false
    dragging = false
    if (!el || !wasDragging)
      return

    const width = el.clientWidth || window.innerWidth
    const elapsed = Math.max(1, performance.now() - startTime)
    const velocity = deltaX / elapsed
    const shouldComplete = deltaX > width * COMPLETE_RATIO || (velocity > COMPLETE_VELOCITY && deltaX > 40)

    if (!shouldComplete) {
      settleBack(el)
      return
    }

    setStyle(el, `translate3d(${width}px, 0, 0)`, `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`)
    await new Promise(resolve => window.setTimeout(resolve, SETTLE_MS))
    try {
      await options.onBack()
    }
    finally {
      reset(el)
    }
  }

  onMounted(() => {
    if (!options.enabled)
      return
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchCancel, { passive: true })
  })

  onBeforeUnmount(() => {
    document.removeEventListener('touchstart', onTouchStart)
    document.removeEventListener('touchmove', onTouchMove)
    document.removeEventListener('touchend', onTouchEnd)
    document.removeEventListener('touchcancel', onTouchCancel)
    clearSettleTimer()
    if (target.value)
      reset(target.value)
  })
}
