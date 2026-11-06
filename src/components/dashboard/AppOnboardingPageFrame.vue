<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconLoader from '~icons/lucide/loader-2'
import IconLogOut from '~icons/lucide/log-out'
import IconX from '~icons/lucide/x'

const props = defineProps<{ canCancel?: boolean, isLoggingOut?: boolean, disabled?: boolean }>()
const emit = defineEmits<{ cancel: [], logout: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 dark:bg-slate-950" data-test="onboarding-page">
    <header class="onboarding-page-actions absolute right-0 top-0 z-20 flex shrink-0 items-center justify-end gap-2 px-2 py-2 sm:px-6 sm:py-3 lg:px-10">
      <slot name="actions" />
      <button
        v-if="props.canCancel"
        type="button"
        class="d-btn d-btn-ghost min-h-10 px-3 text-slate-600 hover:text-slate-950 sm:min-h-11 dark:text-slate-300 dark:hover:text-white"
        data-test="onboarding-cancel-new-org"
        :aria-label="t('button-cancel')"
        :disabled="props.disabled"
        @click="emit('cancel')"
      >
        <IconX class="h-4 w-4" aria-hidden="true" />
        <span class="hidden sm:inline">{{ t('button-cancel') }}</span>
      </button>
      <button
        v-else
        type="button"
        class="d-btn d-btn-ghost min-h-10 px-3 text-slate-600 hover:text-slate-950 sm:min-h-11 dark:text-slate-300 dark:hover:text-white"
        data-test="onboarding-logout"
        :aria-label="t('logout')"
        :disabled="props.isLoggingOut || props.disabled"
        @click="emit('logout')"
      >
        <IconLoader v-if="props.isLoggingOut" class="h-4 w-4 animate-spin" />
        <IconLogOut v-else class="h-4 w-4" aria-hidden="true" />
        <span class="hidden sm:inline" :class="{ 'sm:sr-only': props.isLoggingOut }">{{ t('logout') }}</span>
      </button>
    </header>
    <slot />
  </div>
</template>

<style scoped>
@media (max-width: 639px) {
  :deep(.onboarding-flow-app-creation) {
    padding-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-badge) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-content > :not([hidden]) ~ :not([hidden])),
  :deep(.onboarding-flow-app-creation .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])),
  :deep(.onboarding-flow-app-creation .onboarding-intent-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 1rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-title) {
    margin-top: 0;
    font-size: 1.5rem;
    line-height: 2rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-flow-header nav) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card),
  :deep(.onboarding-flow-app-creation .onboarding-intent-card) {
    padding: 1rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-actions),
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-actions) {
    padding-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-options) {
    gap: 0.5rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-option) {
    min-height: 3.25rem;
    align-items: center;
    padding: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-option-description) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-details-eyebrow),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-upload-helper) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-details-heading h2) {
    margin-top: 0;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-store-import) {
    margin-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-uploader) {
    padding: 0.75rem;
  }
}

@media (max-width: 639px) and (max-height: 700px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-flow-title),
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-flow-header nav) {
    margin-top: 0;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-heading h2) {
    margin-top: 0;
  }
}

@media (max-width: 639px) and (max-height: 630px) {
  :deep(.onboarding-flow-app-creation) {
    padding-block: 0.5rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card),
  :deep(.onboarding-flow-app-creation .onboarding-intent-card) {
    padding: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-title),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-flow-title) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-header nav),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-flow-header nav) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-height: 800px) {
  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name)) {
    padding-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-flow-badge) {
    display: none;
  }

  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name)
      .onboarding-flow-content
      > :not([hidden])
      ~ :not([hidden])
  ),
  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name)
      .onboarding-details-card-content
      > :not([hidden])
      ~ :not([hidden])
  ),
  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name)
      .onboarding-intent-card-content
      > :not([hidden])
      ~ :not([hidden])
  ) {
    margin-top: 1rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-flow-title) {
    margin-top: 0;
    font-size: 1.5rem;
    line-height: 2rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-flow-header nav) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-details-card),
  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-intent-card) {
    padding: 1rem;
  }

  :deep(.onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-details-preview-icon) {
    width: 4rem;
    height: 4rem;
    border-radius: 1.125rem;
  }

  :deep(
    .onboarding-flow-app-creation:not(.onboarding-flow-details-name) .onboarding-details-preview > p:first-of-type
  ) {
    margin-top: 0.5rem;
  }
}

@media (min-width: 640px) and (max-height: 700px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name) {
    padding-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-badge) {
    display: none;
  }

  :deep(
    .onboarding-flow-app-creation.onboarding-flow-details-name
      .onboarding-flow-content
      > :not([hidden])
      ~ :not([hidden])
  ),
  :deep(
    .onboarding-flow-app-creation.onboarding-flow-details-name
      .onboarding-details-card-content
      > :not([hidden])
      ~ :not([hidden])
  ) {
    margin-top: 1rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-title) {
    margin-top: 0;
    font-size: 1.5rem;
    line-height: 2rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-header nav) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-details-card) {
    padding: 1rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-details-preview-icon) {
    width: 4rem;
    height: 4rem;
    border-radius: 1.125rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-details-preview > p:first-of-type) {
    margin-top: 0.5rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-card-content > :not([hidden]) ~ :not([hidden])) {
    margin-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-heading h2),
  :deep(.onboarding-flow-app-creation .onboarding-details-heading p:last-child) {
    margin-top: 0.25rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-store-import) {
    margin-block: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation .onboarding-details-actions),
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-actions) {
    padding-top: 0.75rem;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-details-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-details-heading h2) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-height: 640px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-upload-helper) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-uploader) {
    padding: 0.75rem;
  }
}

@media (min-width: 640px) and (max-height: 590px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-identity) {
    display: none;
  }
}

@media (min-width: 640px) and (max-height: 550px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-eyebrow),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-details-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-heading h2),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-details-heading h2) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-height: 530px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-details-preview),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-flow-title) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-flow-header nav) {
    margin-top: 0;
  }
}

@media (min-width: 640px) and (max-width: 700px) and (max-height: 620px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-eyebrow) {
    display: none;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-intent-heading h2) {
    margin-top: 0;
  }

  :deep(.onboarding-flow-app-creation.onboarding-flow-details-icon .onboarding-icon-identity) {
    display: none;
  }
}

@media (min-width: 640px) and (max-height: 500px) {
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-flow-title),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-title),
  :deep(.onboarding-flow-app-creation.onboarding-flow-intent .onboarding-flow-header nav),
  :deep(.onboarding-flow-app-creation.onboarding-flow-details-name .onboarding-flow-header nav) {
    margin-top: 0;
  }
}
</style>
