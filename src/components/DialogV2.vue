<script setup lang="ts">
import type { WatchStopHandle } from 'vue'
import type { DialogV2Button } from '~/stores/dialogv2'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconClose from '~icons/lucide/x'
import { useDialogV2Store } from '~/stores/dialogv2'

const dialogStore = useDialogV2Store()
const route = useRoute()
const { t } = useI18n()
const titleId = 'dialog-v2-title'

let escapeHandler: ((event: KeyboardEvent) => void) | null = null
let stopRouteWatch: WatchStopHandle | undefined

function normalizeRel(rel?: string, target?: string) {
  const tokens = rel ? rel.split(/[\s,]+/).filter(Boolean) : []
  const relSet = new Set(tokens)
  if (target === '_blank')
    relSet.add('noopener')
  if (relSet.size === 0)
    return undefined
  return Array.from(relSet).join(' ')
}

const sizeClasses = {
  'sm': 'max-w-sm',
  'md': 'max-w-md',
  'lg': 'max-w-lg',
  'xl': 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
}

function getButtonClasses(button: DialogV2Button) {
  const baseClasses = 'd-btn h-auto min-h-10 max-w-full whitespace-normal break-words px-4 py-2 text-sm font-medium text-center shadow-none rounded-lg w-full sm:w-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 focus-visible:ring-offset-base-100'

  const neutralClasses = 'border-slate-200 bg-slate-100 text-slate-800 hover:border-slate-300 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600'
  const roleClasses = {
    primary: 'd-btn-primary',
    secondary: neutralClasses,
    danger: 'border-red-600 bg-red-600 text-white hover:border-red-700 hover:bg-red-700 dark:border-red-500 dark:bg-red-500 dark:hover:border-red-600 dark:hover:bg-red-600',
    cancel: 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-transparent dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-700/60',
    default: neutralClasses,
  } as const

  if (button.placement === 'start') {
    return [
      baseClasses,
      'border-transparent bg-transparent px-2 font-normal text-slate-500 hover:border-transparent hover:bg-transparent hover:text-slate-800 hover:underline underline-offset-4 dark:text-slate-400 dark:hover:text-white',
      button.disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
    ]
  }

  const stateClasses = button.disabled
    ? 'cursor-not-allowed opacity-70'
    : 'cursor-pointer'

  return [
    baseClasses,
    roleClasses[button.role ?? 'default'],
    stateClasses,
  ]
}

const footerButtonGroups = computed(() => {
  const buttons = dialogStore.dialogOptions?.buttons ?? []
  return [
    { key: 'start', buttons: buttons.filter(button => button.placement === 'start'), class: 'sm:flex-row' },
    { key: 'end', buttons: buttons.filter(button => button.placement !== 'start'), class: 'sm:ml-auto sm:flex-row sm:flex-wrap sm:justify-end' },
  ].filter(group => group.buttons.length > 0)
})

function close(button?: DialogV2Button) {
  dialogStore.closeDialog(button)
}

function handleButtonClick(button: DialogV2Button, event?: Event) {
  if (button.disabled) {
    event?.preventDefault()
    return
  }

  const safeButton: DialogV2Button = {
    ...button,
    rel: normalizeRel(button.rel, button.target),
  }

  const mouseEvent = event instanceof MouseEvent ? event : undefined
  const hasModifier = !!(mouseEvent && (mouseEvent.metaKey || mouseEvent.ctrlKey || mouseEvent.shiftKey || mouseEvent.altKey))
  const isModifiedLinkClick = !!(button.href && mouseEvent && (mouseEvent.button !== 0 || hasModifier))

  if (isModifiedLinkClick) {
    close({ ...safeButton, skipNavigation: true })
    return
  }

  // Let target=_blank open natively so browsers do not treat it as a blocked popup.
  if (button.href && button.target === '_blank') {
    close({ ...safeButton, skipNavigation: true })
    return
  }

  const shouldPreventNavigation = button.href && (!mouseEvent || (mouseEvent.button === 0 && !hasModifier))
  if (shouldPreventNavigation)
    event?.preventDefault()

  close(safeButton)
}

onMounted(() => {
  // Close dialog on route change
  stopRouteWatch = watch(route, () => {
    if (dialogStore.showDialog) {
      dialogStore.closeDialog()
    }
  })

  // Close dialog on Escape key
  escapeHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && dialogStore.showDialog && !dialogStore.dialogOptions?.preventAccidentalClose) {
      dialogStore.closeDialog()
    }
  }
  addEventListener('keydown', escapeHandler)
})

onUnmounted(() => {
  stopRouteWatch?.()
  stopRouteWatch = undefined

  if (escapeHandler) {
    removeEventListener('keydown', escapeHandler)
    escapeHandler = null
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="dialogStore.showDialog" class="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <!-- Backdrop -->
      <div
        class="dialog-v2-backdrop fixed inset-0 bg-slate-950/60"
        :class="{ 'cursor-pointer': !dialogStore.dialogOptions?.preventAccidentalClose }"
        aria-hidden="true"
        @click="!dialogStore.dialogOptions?.preventAccidentalClose && close()"
      />

      <!-- Dialog -->
      <div
        role="dialog"
        aria-modal="true"
        :aria-labelledby="dialogStore.dialogOptions?.title ? titleId : undefined"
        class="dialog-v2-panel relative flex w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-base-100 shadow-2xl max-h-[calc(100dvh-2rem)] sm:max-h-[90vh] dark:border-slate-700"
        :class="[
          sizeClasses[dialogStore.dialogOptions?.size || 'md'],
        ]"
      >
        <div class="overflow-y-auto overscroll-contain">
          <!-- Header -->
          <div
            v-if="dialogStore.dialogOptions?.title"
            class="flex items-start gap-4 px-6 pt-5 pb-2"
          >
            <h3 :id="titleId" class="flex-1 min-w-0 pt-0.5 text-lg font-semibold leading-7 text-base-content break-words">
              {{ dialogStore.dialogOptions.title }}
            </h3>
            <button
              v-if="!dialogStore.dialogOptions?.preventAccidentalClose"
              type="button"
              class="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-400 cursor-pointer transition-colors duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:hover:bg-slate-700 dark:hover:text-white"
              :aria-label="t('close')"
              @click="close()"
            >
              <IconClose class="size-5" />
            </button>
          </div>

          <!-- Close button without header -->
          <button
            v-else-if="!dialogStore.dialogOptions?.preventAccidentalClose"
            type="button"
            class="absolute z-10 top-3 right-3 flex size-9 items-center justify-center rounded-lg text-slate-400 cursor-pointer transition-colors duration-150 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:hover:bg-slate-700 dark:hover:text-white"
            :aria-label="t('close')"
            @click="close()"
          >
            <IconClose class="size-5" />
          </button>

          <!-- Content -->
          <div class="px-6" :class="{ 'pt-6': !dialogStore.dialogOptions?.title }">
            <!-- Default description -->
            <div v-if="dialogStore.dialogOptions?.description" class="pb-4">
              <p class="text-sm leading-6 text-slate-600 whitespace-pre-wrap break-words dark:text-slate-300">
                {{ dialogStore.dialogOptions.description }}
              </p>
            </div>

            <!-- Teleport target for custom content -->
            <div id="dialog-v2-content" class="pb-4 text-base-content/70" />
          </div>
        </div>

        <!-- Buttons -->
        <div
          v-if="dialogStore.dialogOptions?.buttons?.length"
          class="shrink-0 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-700 dark:bg-slate-900/40"
        >
          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <div
              v-for="group in footerButtonGroups"
              :key="group.key"
              class="flex flex-col-reverse gap-2"
              :class="group.class"
            >
              <template v-for="(button, i) in group.buttons" :key="`${group.key}-${i}`">
                <button
                  v-if="!button.href"
                  type="button"
                  :class="getButtonClasses(button)"
                  :disabled="button.disabled"
                  :data-test="button.id"
                  @click="handleButtonClick(button, $event)"
                >
                  {{ button.text }}
                </button>

                <a
                  v-else
                  :href="button.href"
                  :target="button.target"
                  :rel="normalizeRel(button.rel, button.target)"
                  :class="[getButtonClasses(button), button.disabled ? 'pointer-events-none' : '']"
                  :aria-disabled="button.disabled || undefined"
                  :tabindex="button.disabled ? -1 : undefined"
                  @click="handleButtonClick(button, $event)"
                >
                  {{ button.text }}
                </a>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
