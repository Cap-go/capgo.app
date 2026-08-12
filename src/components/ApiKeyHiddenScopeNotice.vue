<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconInformationCircle from '~icons/heroicons/information-circle'

interface Props {
  hiddenCount: number
  isLoading?: boolean
}

withDefaults(defineProps<Props>(), {
  isLoading: false,
})

const emit = defineEmits<{
  removeFilter: []
}>()

const { t } = useI18n()
</script>

<template>
  <div
    v-if="!isLoading && hiddenCount > 0"
    role="status"
    class="mx-3 mb-3 flex items-start gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200"
  >
    <IconInformationCircle
      data-test="scope-notice-icon"
      aria-hidden="true"
      class="mt-0.5 size-5 shrink-0 text-blue-500 dark:text-blue-400"
    />
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span>
        {{ hiddenCount === 1
          ? t('api-key-hidden-by-scope-filter-one')
          : t('api-keys-hidden-by-scope-filter-many', { count: hiddenCount }) }}
      </span>
      <button
        type="button"
        class="d-btn d-btn-link h-auto min-h-0 rounded-sm border-0 p-0 font-semibold text-blue-600 underline underline-offset-2 shadow-none hover:text-blue-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:text-blue-400 dark:hover:text-blue-300 dark:focus-visible:ring-offset-slate-800"
        @click="emit('removeFilter')"
      >
        {{ t('remove-api-key-scope-filter') }}
      </button>
    </div>
  </div>
</template>
