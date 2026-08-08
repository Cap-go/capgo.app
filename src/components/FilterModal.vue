<script setup lang="ts">
import { nextTick, onUnmounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconClose from '~icons/heroicons/x-mark'

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
    getFocusable()[0]?.focus()
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
      class="d-modal d-modal-open"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :data-test="`${testPrefix()}-filters-modal`"
    >
      <div
        ref="modalBoxRef"
        class="d-modal-box w-[calc(100vw-2rem)] max-w-md rounded-lg border border-slate-200 bg-white p-0 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div class="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div class="min-w-0">
            <h2
              :id="titleId"
              class="text-lg font-semibold leading-7 text-slate-950 dark:text-white"
            >
              {{ title }}
            </h2>
            <p v-if="subtitle" class="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-300">
              {{ subtitle }}
            </p>
          </div>
          <button
            type="button"
            class="d-btn d-btn-ghost d-btn-square min-h-11 w-11 shrink-0 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            :aria-label="t('close')"
            :data-test="`${testPrefix()}-filters-close`"
            @click="emit('close')"
          >
            <IconClose class="h-5 w-5" />
          </button>
        </div>

        <div class="max-h-[min(28rem,60vh)] space-y-5 overflow-y-auto px-5 py-5">
          <slot />
        </div>

        <div class="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
          <button
            type="button"
            class="d-btn d-btn-ghost min-h-11"
            :data-test="`${testPrefix()}-filters-clear`"
            :disabled="clearDisabled"
            @click="emit('clear')"
          >
            {{ t('clear-filters') }}
          </button>
          <button
            type="button"
            class="d-btn d-btn-primary min-h-11"
            :data-test="`${testPrefix()}-filters-done`"
            @click="emit('close')"
          >
            {{ t('done') }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="d-modal-backdrop"
        :aria-label="t('close')"
        @click="emit('close')"
      />
    </div>
  </Teleport>
</template>
