import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'

export interface UseAnchorPopoverOptions {
  /** Fallback panel width before first layout measure. */
  defaultWidth?: number
  /** Horizontal alignment of the panel relative to the trigger. */
  align?: 'start' | 'end'
}

/**
 * Shared floating-panel behavior for table-cell popovers (positioning,
 * hover/click open, outside click, Escape, viewport reposition).
 */
export function useAnchorPopover(options: UseAnchorPopoverOptions = {}) {
  const defaultWidth = options.defaultWidth ?? 280
  const align = options.align ?? 'start'

  const isOpen = ref(false)
  const triggerRef = useTemplateRef<HTMLButtonElement>('triggerRef')
  const popoverRef = useTemplateRef<HTMLElement>('popoverRef')
  const popoverStyle = ref<Record<string, string>>({})
  const finePointer = ref(false)
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  function updatePopoverPosition() {
    const anchor = triggerRef.value
    if (!anchor)
      return
    const rect = anchor.getBoundingClientRect()
    const margin = 12
    const gap = 8
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const maxHeight = Math.max(160, viewportH - margin * 2)
    const panel = popoverRef.value
    const panelWidth = Math.min(panel?.offsetWidth || defaultWidth, viewportW - margin * 2)
    const panelHeight = Math.min(panel?.offsetHeight || 0, maxHeight)

    let left = align === 'end' ? rect.right - panelWidth : rect.left
    left = Math.min(left, viewportW - margin - panelWidth)
    left = Math.max(margin, left)

    let top = rect.bottom + gap
    if (panelHeight && top + panelHeight > viewportH - margin)
      top = rect.top - panelHeight - gap
    top = Math.min(Math.max(margin, top), viewportH - margin - (panelHeight || 0))

    popoverStyle.value = {
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    }
  }

  function cancelClose() {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer)
      closeTimer = undefined
    }
  }

  function closePanel() {
    cancelClose()
    isOpen.value = false
  }

  async function openPanel(focusFirstButton = false) {
    cancelClose()
    updatePopoverPosition()
    isOpen.value = true
    await nextTick()
    updatePopoverPosition()
    if (focusFirstButton)
      popoverRef.value?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  function togglePanel(focusFirstButton = false) {
    if (isOpen.value)
      closePanel()
    else
      void openPanel(focusFirstButton)
  }

  function onTriggerLeave() {
    if (!finePointer.value)
      return
    cancelClose()
    closeTimer = setTimeout(() => {
      closePanel()
    }, 150)
  }

  function onViewportChange() {
    if (isOpen.value)
      updatePopoverPosition()
  }

  onClickOutside(popoverRef, (event) => {
    const target = event.target as Node | null
    if (target && triggerRef.value?.contains(target))
      return
    closePanel()
  })

  onKeyStroke('Escape', (event) => {
    if (!isOpen.value)
      return
    event.preventDefault()
    closePanel()
    triggerRef.value?.focus()
  })

  onMounted(() => {
    finePointer.value = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
  })

  onUnmounted(() => {
    cancelClose()
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  })

  return {
    isOpen,
    triggerRef,
    popoverRef,
    popoverStyle,
    finePointer,
    cancelClose,
    closePanel,
    openPanel,
    togglePanel,
    onTriggerLeave,
    updatePopoverPosition,
  }
}
