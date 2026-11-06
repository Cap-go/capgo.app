<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import IconX from '~icons/heroicons/x-mark'
import { setBillingModalOpen } from '~/services/billingModalState'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  size?: 'md' | 'lg' | 'xl' | 'checkout'
  // Block Escape/backdrop while a payment is being confirmed.
  busy?: boolean
  // Drop body padding so embedded content (e.g. Stripe Checkout iframe) fills the modal edge to edge.
  flush?: boolean
  // Hide the visual header when the content already shows its own title (e.g. Stripe Checkout).
  // The title stays available to screen readers and the close button floats in the corner.
  headerless?: boolean
}>(), {
  size: 'md',
  busy: false,
  flush: false,
  headerless: false,
})

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const titleId = useId()
const box = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

const sizeClass = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  // Stripe Embedded Checkout only switches to its two-column layout when its container is ~1000px+.
  checkout: 'max-w-6xl',
}

function requestClose() {
  if (!props.busy)
    emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape')
    return
  event.preventDefault()
  event.stopPropagation()
  requestClose()
}

// Escape while focus has left the dialog (e.g. on <body>); keys inside Stripe iframes never bubble.
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape')
    requestClose()
}

onMounted(async () => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  setBillingModalOpen(true)
  window.addEventListener('keydown', onWindowKeydown)
  await nextTick()
  box.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  setBillingModalOpen(false)
  // Return focus to the control that opened the dialog.
  previouslyFocused?.focus?.()
})
</script>

<template>
  <Teleport to="body">
    <dialog
      open
      class="d-modal d-modal-open"
      aria-modal="true"
      :aria-labelledby="titleId"
      @click.self="requestClose"
      @keydown="onKeydown"
      @cancel.prevent="requestClose"
    >
      <div
        ref="box"
        tabindex="-1"
        class="d-modal-box relative outline-none w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-0 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        :class="sizeClass[props.size]"
      >
        <template v-if="props.headerless">
          <h2 :id="titleId" class="sr-only">
            {{ props.title }}
          </h2>
          <button
            type="button"
            class="d-btn d-btn-circle d-btn-sm absolute right-3 top-3 z-10 border-slate-200 bg-white/90 text-slate-700 shadow-sm hover:bg-white dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:bg-slate-800"
            :aria-label="t('button-cancel')"
            :disabled="props.busy"
            data-test="billing-modal-close"
            @click="requestClose"
          >
            <IconX class="h-5 w-5" />
          </button>
        </template>
        <div v-else class="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
          <div class="min-w-0">
            <h2 :id="titleId" class="text-lg font-semibold leading-7 text-slate-950 dark:text-white">
              {{ props.title }}
            </h2>
            <p v-if="props.description" class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ props.description }}
            </p>
          </div>
          <button
            type="button"
            class="d-btn d-btn-ghost d-btn-sm d-btn-square shrink-0"
            :aria-label="t('button-cancel')"
            :disabled="props.busy"
            data-test="billing-modal-close"
            @click="requestClose"
          >
            <IconX class="h-5 w-5" />
          </button>
        </div>
        <div :class="props.flush ? '' : 'px-5 py-5 sm:px-6'">
          <slot />
        </div>
        <div v-if="$slots.footer" class="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800 sm:px-6">
          <slot name="footer" />
        </div>
      </div>
    </dialog>
  </Teleport>
</template>
