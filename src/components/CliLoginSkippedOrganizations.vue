<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'

defineProps<{
  organizations: Array<{ id: string, name: string }>
  hasKey?: boolean
}>()

const { t } = useI18n()

function reloadPage(): void {
  window.location.reload()
}
</script>

<template>
  <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/60">
    <div class="flex items-start gap-3">
      <IconExclamationTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
      <div class="min-w-0 flex-1 space-y-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <p class="font-semibold text-slate-900 dark:text-slate-100">
          {{ t('cli-login-skipped-title') }}
        </p>
        <p>{{ t(hasKey ? 'cli-login-skipped-description' : 'cli-login-skipped-description-empty') }}</p>
        <ul class="flex flex-wrap gap-2">
          <li
            v-for="organization in organizations"
            :key="organization.id"
            class="rounded-full border border-slate-200 bg-white px-3 py-0.5 font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {{ organization.name }}
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
        <p>
          {{ t('cli-login-skipped-hint') }}
          <button
            class="font-medium text-slate-900 underline decoration-slate-400 underline-offset-2 hover:decoration-slate-600 dark:text-slate-100 dark:hover:decoration-slate-300"
            type="button"
            @click="reloadPage"
          >
            {{ t('cli-login-skipped-refresh') }}
          </button>
        </p>
      </div>
    </div>
  </div>
</template>
