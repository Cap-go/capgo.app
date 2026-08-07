<script setup lang="ts">
import type { WatchStopHandle } from 'vue'
import type { DialogV2Button } from '~/stores/dialogv2'
import { onMounted, onUnmounted, watch } from 'vue'
import { useDialogV2Store } from '~/stores/dialogv2'

const dialogStore = useDialogV2Store()
const route = useRoute()

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
  const baseClasses = 'd-btn h-auto min-h-12 max-w-full whitespace-normal break-words py-3 text-center'

  const roleClasses = {
    primary: 'd-btn-primary',
    secondary: 'd-btn-secondary',
    danger: 'd-btn-warning',
    cancel: 'd-btn-outline',
    default: '',
  } as const

  const stateClasses = button.disabled
    ? 'cursor-not-allowed opacity-70'
    : 'cursor-pointer'

  return [
    baseClasses,
    roleClasses[button.role ?? 'default'],
    stateClasses,
  ]
}

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
    <div v-if="dialogStore.showDialog" class="fixed inset-0 z-50 flex items-center justify-center">
      <!-- Backdrop -->
      <div
        class="fixed inset-0 bg-black/50"
        :class="{ 'cursor-pointer': !dialogStore.dialogOptions?.preventAccidentalClose }"
        @click="!dialogStore.dialogOptions?.preventAccidentalClose && close()"
      />

      <!-- Dialog -->
      <div
        class="overflow-y-auto relative mx-4 w-full bg-base-100 rounded-lg shadow-xl max-h-[90vh]"
        :class="[
          sizeClasses[dialogStore.dialogOptions?.size || 'md'],
        ]"
      >
        <!-- Close button -->
        <button
          v-if="!dialogStore.dialogOptions?.preventAccidentalClose"
          class="absolute z-10 text-2xl text-base-content top-4 right-4 hover:text-base-content hover:bg-base-200 d-btn d-btn-sm d-btn-circle d-btn-ghost"
          @click="close()"
        >
          ✕
        </button>

        <!-- Header -->
        <div v-if="dialogStore.dialogOptions?.title" class="px-6 pt-6 pb-2">
          <h3 class="text-lg font-bold text-base-content">
            {{ dialogStore.dialogOptions.title }}
          </h3>
        </div>

        <!-- Content -->
        <div class="px-6" :class="{ 'pt-6': !dialogStore.dialogOptions?.title }">
          <!-- Default description -->
          <div v-if="dialogStore.dialogOptions?.description" class="pb-4">
            <p class="text-base text-base-content/70 whitespace-pre-wrap break-words">
              {{ dialogStore.dialogOptions.description }}
            </p>
          </div>

          <!-- Teleport target for custom content -->
          <div id="dialog-v2-content" class="pb-4 text-base-content/70" />
        </div>

        <!-- Buttons -->
        <div v-if="dialogStore.dialogOptions?.buttons?.length" class="px-6 pb-6">
          <div class="flex flex-wrap justify-end gap-2">
            <template v-for="(button, i) in dialogStore.dialogOptions.buttons" :key="i">
              <button
                v-if="!button.href"
                type="button"
                :class="getButtonClasses(button)"
                :disabled="button.disabled"
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
  </Teleport>
</template>
