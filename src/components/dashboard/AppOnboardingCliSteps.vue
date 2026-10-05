<script setup lang="ts">
import type { AppOnboardingStepStatus } from '~/services/appOnboarding'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconMinus from '~icons/lucide/minus'
import { useAppOnboardingCliProgress } from '~/composables/useAppOnboardingCliProgress'
import { APP_ONBOARDING_OTA_V1_STEP_IDS, getAppOnboardingStepIds } from '~/services/appOnboarding'

const props = defineProps<{
  appId: string
  initialOnboarding?: unknown
}>()

const { t } = useI18n()
const isOpen = ref(false)
const { onboarding } = useAppOnboardingCliProgress(() => props.appId, () => props.initialOnboarding)

// Every app shows the seven OTA setup steps. The legacy v1/v2 lists share
// these ids, except v1 called the first one add_app.
const stepIds = computed(() => onboarding.value.todo_list_version === 4
  ? getAppOnboardingStepIds(4, onboarding.value.ota_todo_list_version)
  : APP_ONBOARDING_OTA_V1_STEP_IDS)
const steps = computed(() => stepIds.value.map(id => ({
  id,
  status: (onboarding.value.steps[id]?.status
    ?? (id === 'login_cli_mcp' ? onboarding.value.steps.add_app?.status : undefined)) as AppOnboardingStepStatus | undefined,
  title: t(`setup-checklist-step-${id}`),
})))

const doneCount = computed(() => steps.value.filter(step => step.status === 'done' || step.status === 'skipped').length)

watch(doneCount, (count) => {
  if (count > 0)
    isOpen.value = true
}, { immediate: true })

function statusLabel(status: AppOnboardingStepStatus | undefined) {
  if (status === 'done')
    return t('app-onboarding-cli-step-done')
  if (status === 'skipped')
    return t('app-onboarding-cli-step-skipped')
  return t('app-onboarding-cli-step-pending')
}
</script>

<template>
  <div
    v-if="steps.length"
    class="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/15 dark:bg-slate-950/90"
    data-test="app-onboarding-cli-steps"
  >
    <button
      type="button"
      class="d-btn d-btn-ghost d-btn-block h-auto min-h-0 justify-between gap-3 rounded-none px-4 py-3 text-left"
      :aria-expanded="isOpen"
      :aria-controls="`app-onboarding-cli-steps-${appId}`"
      @click="isOpen = !isOpen"
    >
      <span class="min-w-0">
        <span class="block text-sm font-medium text-slate-950 dark:text-white">
          {{ t('setup-checklist-list-title') }}
        </span>
        <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">
          {{ t('app-onboarding-cli-steps-progress', { done: doneCount, total: steps.length }) }}
        </span>
      </span>
      <IconChevronDown
        class="h-4 w-4 shrink-0 text-slate-400 transition-transform"
        :class="isOpen ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <div
      v-show="isOpen"
      :id="`app-onboarding-cli-steps-${appId}`"
      class="border-t border-slate-200 px-4 py-3 dark:border-white/10"
    >
      <p class="mb-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
        {{ t('setup-checklist-list-subtitle') }}
      </p>
      <ol class="space-y-2">
        <li
          v-for="step in steps"
          :key="step.id"
          class="flex items-center gap-3"
          :data-test="`app-onboarding-cli-step-${step.id}`"
          :data-status="step.status ?? 'pending'"
        >
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
            :class="step.status === 'done'
              ? 'bg-emerald-500 text-white'
              : step.status === 'skipped'
                ? 'bg-amber-500 text-white'
                : 'border border-slate-300 bg-white text-slate-400 dark:border-white/20 dark:bg-slate-900'"
            :aria-label="statusLabel(step.status)"
          >
            <IconCheck v-if="step.status === 'done'" class="h-3.5 w-3.5" />
            <IconMinus v-else-if="step.status === 'skipped'" class="h-3.5 w-3.5" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm text-slate-800 dark:text-slate-100">
              {{ step.title }}
            </span>
            <span class="block text-[11px] text-slate-500 dark:text-slate-400">
              {{ statusLabel(step.status) }}
            </span>
          </span>
        </li>
      </ol>
    </div>
  </div>
</template>
