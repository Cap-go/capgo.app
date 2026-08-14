<script setup lang="ts">
import type { AppOnboardingStepStatus } from '~/services/appOnboarding'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconMinus from '~icons/lucide/minus'
import { APP_ONBOARDING_STEP_IDS, parseAppOnboarding } from '~/services/appOnboarding'
import { useSupabase } from '~/services/supabase'

const props = defineProps<{
  appId: string
  initialOnboarding?: unknown
}>()

const { t } = useI18n()
const supabase = useSupabase()
const isOpen = ref(false)
const onboarding = ref(parseAppOnboarding(props.initialOnboarding))
let pollTimer: number | null = null

const steps = computed(() => APP_ONBOARDING_STEP_IDS.map(id => ({
  id,
  status: onboarding.value.steps[id]?.status as AppOnboardingStepStatus | undefined,
  title: t(`app-onboarding-cli-step-${id}`),
})))

const doneCount = computed(() => steps.value.filter(step => step.status === 'done' || step.status === 'skipped').length)

watch(() => props.initialOnboarding, (value) => {
  onboarding.value = parseAppOnboarding(value)
})

watch(doneCount, (count) => {
  if (count > 0)
    isOpen.value = true
}, { immediate: true })

async function refreshOnboarding() {
  const { data } = await supabase
    .from('apps')
    .select('onboarding')
    .eq('app_id', props.appId)
    .maybeSingle()

  if (data)
    onboarding.value = parseAppOnboarding(data.onboarding)
}

function statusLabel(status: AppOnboardingStepStatus | undefined) {
  if (status === 'done')
    return t('app-onboarding-cli-step-done')
  if (status === 'skipped')
    return t('app-onboarding-cli-step-skipped')
  return t('app-onboarding-cli-step-pending')
}

onMounted(() => {
  void refreshOnboarding()
  pollTimer = window.setInterval(() => {
    void refreshOnboarding()
  }, 2000)
})

onBeforeUnmount(() => {
  if (pollTimer !== null)
    window.clearInterval(pollTimer)
})
</script>

<template>
  <div
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
          {{ t('app-onboarding-cli-steps-title') }}
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
        {{ t('app-onboarding-cli-steps-subtitle') }}
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
