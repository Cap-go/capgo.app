<script setup lang="ts">
import { useI18n } from 'vue-i18n'

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
    class="mx-3 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm text-cyan-900 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-100"
  >
    <span>
      {{ hiddenCount === 1
        ? t('api-key-hidden-by-scope-filter-one')
        : t('api-keys-hidden-by-scope-filter-many', { count: hiddenCount }) }}
    </span>
    <button
      type="button"
      class="d-btn d-btn-link h-auto min-h-0 rounded-sm border-0 p-0 font-semibold text-cyan-700 underline underline-offset-2 shadow-none hover:text-cyan-900 focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:text-cyan-200 dark:hover:text-white dark:focus-visible:ring-offset-slate-800"
      @click="emit('removeFilter')"
    >
      {{ t('remove-api-key-scope-filter') }}
    </button>
  </div>
</template>
