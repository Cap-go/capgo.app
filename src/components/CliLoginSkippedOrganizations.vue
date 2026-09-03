<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'

defineProps<{
  organizations: string[]
}>()

const { t } = useI18n()
</script>

<template>
  <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60" role="status">
    <div class="flex items-start gap-3">
      <IconExclamationTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
      <div class="min-w-0 flex-1 space-y-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <p class="font-semibold text-slate-900 dark:text-slate-100">
          {{ t('cli-login-skipped-title') }}
        </p>
        <p>{{ t('cli-login-skipped-description') }}</p>
        <ul class="flex flex-wrap gap-2">
          <li
            v-for="organization in organizations"
            :key="organization"
            class="rounded-full border border-slate-200 bg-white px-3 py-0.5 font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {{ organization }}
          </li>
        </ul>
        <div class="space-y-1">
          <p>{{ t('cli-login-skipped-reasons-intro') }}</p>
          <ul class="list-disc space-y-1 pl-5">
            <li>{{ t('cli-login-skipped-reason-invite') }}</li>
            <li>{{ t('cli-login-skipped-reason-role') }}</li>
            <li>{{ t('cli-login-skipped-reason-security') }}</li>
          </ul>
        </div>
        <p>{{ t('cli-login-skipped-hint') }}</p>
      </div>
    </div>
  </div>
</template>
