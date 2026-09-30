<script setup lang="ts">
import { nextTick, onUnmounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconClose from '~icons/lucide/x'

const props = defineProps<{
  open: boolean
  title: string
  subtitle?: string
  titleId: string
  clearDisabled?: boolean
  testIdPrefix?: string
  restoreFocusEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  close: []
  clear: []
}>()

const { t } = useI18n()
const modalBoxRef = useTemplateRef<HTMLElement>('modalBoxRef')
const testPrefix = () => props.testIdPrefix ?? 'data-table'

function getFocusable() {
  const root = modalBoxRef.value
  if (!root)
    return [] as HTMLElement[]
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open)
    return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Tab')
    return
  const focusable = getFocusable()
  if (!focusable.length)
    return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  }
  else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    window.addEventListener('keydown', onKeydown)
    await nextTick()
    const focusable = getFocusable()
    const firstField = focusable.find(el => el.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea'))
    ;(firstField ?? modalBoxRef.value)?.focus({ preventScroll: true })
  }
  else {
    window.removeEventListener('keydown', onKeydown)
    await nextTick()
    props.restoreFocusEl?.focus()
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[999] flex items-end justify-center p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :data-test="`${testPrefix()}-filters-modal`"
    >
      <button
        type="button"
        class="dialog-v2-backdrop fixed inset-0 cursor-pointer bg-slate-950/60"
        tabindex="-1"
        :aria-label="t('close')"
        @click="emit('close')"
      />
      <div
        ref="modalBoxRef"
        tabindex="-1"
        class="dialog-v2-panel relative flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl outline-none max-h-[calc(100dvh-2rem)] dark:border-slate-700 dark:bg-slate-800"
      >
        <div class="flex items-start gap-4 px-5 pt-5 pb-4">
          <div class="min-w-0 flex-1">
            <h2
              :id="titleId"
              class="text-lg font-semibold leading-7 text-slate-900 dark:text-white"
            >
              {{ title }}
            </h2>
            <p v-if="subtitle" class="mt-0.5 text-sm leading-5 text-slate-500 dark:text-slate-400">
              {{ subtitle }}
            </p>
          </div>
          <button
            type="button"
            class="-mr-2 -mt-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:hover:bg-slate-700 dark:hover:text-white"
            :aria-label="t('close')"
            :data-test="`${testPrefix()}-filters-close`"
            @click="emit('close')"
          >
            <IconClose class="size-5" />
          </button>
        </div>

        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain border-t border-slate-100 px-5 py-4 dark:border-slate-700">
          <slot />
        </div>

        <div class="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-700 dark:bg-slate-900/40">
          <button
            type="button"
            class="h-9 cursor-pointer rounded-lg px-2 text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 disabled:cursor-default disabled:text-slate-400 disabled:no-underline dark:text-slate-300 dark:hover:text-white dark:disabled:text-slate-500"
            :data-test="`${testPrefix()}-filters-clear`"
            :disabled="clearDisabled"
            @click="emit('clear')"
          >
            {{ t('clear-filters') }}
          </button>
          <button
            type="button"
            class="d-btn d-btn-primary h-9 min-h-9 rounded-lg px-5 text-sm font-medium shadow-none"
            :data-test="`${testPrefix()}-filters-done`"
            @click="emit('close')"
          >
            {{ t('done') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
