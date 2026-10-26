<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCreditCard from '~icons/lucide/credit-card'

// First onboarding step for direct-offer orgs (no free trial, never paid):
// they cannot publish updates until they subscribe, so the plan comes first.
const { t } = useI18n()
</script>

<template>
  <section
    class="mb-6 rounded-2xl border-2 border-primary-500 bg-white p-5 shadow-sm sm:p-6 dark:border-azure-400 dark:bg-slate-900"
    aria-labelledby="onboarding-choose-plan-title"
    data-test="onboarding-choose-plan-step"
  >
    <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
      <div class="flex min-w-0 flex-1 items-start gap-4">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-500 text-white dark:bg-azure-500" aria-hidden="true">
          <IconCreditCard class="h-5 w-5" />
        </span>
        <div class="min-w-0">
          <p class="text-sm font-medium text-sky-700 dark:text-azure-400">
            {{ t('onboarding-choose-plan-step-label') }}
          </p>
          <h2 id="onboarding-choose-plan-title" class="mt-1 text-xl font-semibold leading-tight text-slate-950 sm:text-2xl dark:text-white">
            {{ t('choose-a-plan') }}
          </h2>
          <p class="mt-2 text-base leading-7 text-slate-700 dark:text-slate-200">
            {{ t('onboarding-choose-plan-step-description') }}
            <span class="font-medium">{{ t('no-trial-money-back-guarantee-description') }}</span>
          </p>
          <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {{ t('onboarding-choose-plan-step-next') }}
          </p>
        </div>
      </div>
      <router-link
        to="/settings/organization/plans"
        class="d-btn min-h-12 shrink-0 self-start border-primary-500 bg-primary-500 px-5 text-base text-white hover:border-primary-600 hover:bg-primary-600 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 sm:self-center"
        data-test="onboarding-choose-plan-cta"
      >
        {{ t('onboarding-choose-plan-step-cta') }}
        <IconArrowRight class="h-4 w-4" aria-hidden="true" />
      </router-link>
    </div>
  </section>
</template>
