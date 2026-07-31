<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconChevronRight from '~icons/heroicons/chevron-right'
import IconCurrencyDollar from '~icons/heroicons/currency-dollar'
import IconInformationCircle from '~icons/heroicons/information-circle'

const props = withDefaults(defineProps<{
  /**
   * When true, displays an informational banner for credits-only orgs
   * (orgs with credits but no active subscription plan).
   * Uses the information icon and different copy to avoid misleading
   * the user into thinking they need to "upgrade" — they already know
   * about credits since that is their primary payment method.
   */
  creditsOnly?: boolean
}>(), {
  creditsOnly: false,
})

const { t } = useI18n()
const router = useRouter()

function goToCredits() {
  router.push('/settings/organization/credits')
}
</script>

<template>
  <!-- Credits-only info banner: shown for orgs using credits without a plan -->
  <button
    v-if="props.creditsOnly"
    type="button"
    class="d-btn flex h-auto min-h-[4.5rem] items-center w-full p-4 text-left transition-all duration-200 border cursor-pointer bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 hover:border-blue-300 dark:hover:border-blue-700 rounded-xl group"
    @click="goToCredits"
  >
    <!-- Icon -->
    <div class="flex items-center justify-center w-10 h-10 rounded-full shrink-0 bg-blue-100 dark:bg-blue-900/30">
      <IconInformationCircle class="w-5 h-5 text-blue-600 dark:text-blue-400" />
    </div>

    <!-- Text content -->
    <div class="flex-1 min-w-0 ml-4">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
        {{ t('credits-only-info-title') }}
      </h3>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
        {{ t('credits-only-info-description') }}
      </p>
    </div>

    <!-- Link with arrow -->
    <div class="flex items-center ml-4 shrink-0">
      <span class="hidden text-sm font-medium text-blue-600 transition-colors sm:inline dark:text-blue-400 group-hover:text-blue-700 dark:group-hover:text-blue-300">
        {{ t('credits-only-info-link') }}
      </span>
      <IconChevronRight class="w-5 h-5 ml-1 text-blue-600 transition-transform dark:text-blue-400 group-hover:translate-x-0.5" />
    </div>
  </button>

  <!-- Default CTA: "Don't want to upgrade?" — hidden for credits-only orgs
       because they already know about credits and this message would be confusing -->
  <button
    v-else
    type="button"
    class="d-btn flex h-auto min-h-[4.5rem] items-center w-full p-4 text-left transition-all duration-200 border cursor-pointer bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700 rounded-xl group"
    @click="goToCredits"
  >
    <!-- Icon -->
    <div class="flex items-center justify-center w-10 h-10 rounded-full shrink-0 bg-blue-100 dark:bg-blue-900/30">
      <IconCurrencyDollar class="w-5 h-5 text-blue-600 dark:text-blue-400" />
    </div>

    <!-- Text content -->
    <div class="flex-1 min-w-0 ml-4">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
        {{ t('credits-flexibility-cta-title') }}
      </h3>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
        {{ t('credits-flexibility-cta-description') }}
      </p>
    </div>

    <!-- Link with arrow -->
    <div class="flex items-center ml-4 shrink-0">
      <span class="hidden text-sm font-medium text-blue-600 transition-colors sm:inline dark:text-blue-400 group-hover:text-blue-700 dark:group-hover:text-blue-300">
        {{ t('credits-flexibility-cta-link') }}
      </span>
      <IconChevronRight class="w-5 h-5 ml-1 text-blue-600 transition-transform dark:text-blue-400 group-hover:translate-x-0.5" />
    </div>
  </button>
</template>
