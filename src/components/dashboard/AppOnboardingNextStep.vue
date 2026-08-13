<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCompass from '~icons/lucide/compass'
import {
  onboardingNextStepMessageKeys,
  parseAppOnboardingLedger,
  shouldShowOnboardingNextStep,
} from '~/utils/appOnboardingProgress'

const props = defineProps<{
  app: Database['public']['Tables']['apps']['Row']
}>()

const { t } = useI18n()

const ledger = computed(() => parseAppOnboardingLedger(props.app.onboarding))
const visible = computed(() => shouldShowOnboardingNextStep(ledger.value))
const messageKeys = computed(() => onboardingNextStepMessageKeys(ledger.value))
</script>

<template>
  <div
    v-if="visible"
    data-test="app-onboarding-next-step"
    class="block w-full mb-4 overflow-hidden text-left border rounded-lg border-sky-200 bg-sky-50 dark:bg-sky-900/20 dark:border-sky-800"
  >
    <div class="flex items-center justify-between p-4">
      <div class="flex items-center gap-3 min-w-0">
        <div class="flex items-center justify-center flex-shrink-0 w-10 h-10 rounded-full bg-sky-100 dark:bg-sky-900/50">
          <IconCompass class="w-5 h-5 text-sky-600 dark:text-sky-400" />
        </div>
        <div class="min-w-0">
          <p class="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            {{ t('onboarding-next-title') }}
          </p>
          <p class="font-semibold text-sky-900 dark:text-sky-100">
            {{ t(messageKeys.titleKey) }}
          </p>
          <p class="text-sm text-sky-700 dark:text-sky-300">
            {{ t(messageKeys.descKey) }}
          </p>
        </div>
      </div>
      <IconArrowRight class="hidden w-5 h-5 text-sky-500 sm:block shrink-0" aria-hidden="true" />
    </div>
  </div>
</template>
