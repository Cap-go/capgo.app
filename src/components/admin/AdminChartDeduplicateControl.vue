<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const modelValue = defineModel<boolean>({ required: true })
const { t } = useI18n()
</script>

<template>
  <div class="mt-4 flex justify-end border-t border-slate-200/80 pt-4 dark:border-slate-700/80">
    <label
      data-test="deduplicate-by-user"
      class="inline-flex cursor-pointer items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/70 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:border-indigo-500/70 dark:hover:bg-indigo-500/10"
    >
      <input
        v-model="modelValue"
        type="checkbox"
        class="d-checkbox d-checkbox-primary d-checkbox-sm"
      >
      <span>{{ t('frontend-onboarding-deduplicate-by-user') }}</span>
    </label>
  </div>
</template>
