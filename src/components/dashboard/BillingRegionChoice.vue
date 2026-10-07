<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCheck from '~icons/lucide/check'
import IconLandmark from '~icons/lucide/landmark'
import { invokeCapgoApi } from '~/services/capgoApi'

type BillingAccount = 'ee' | 'us'

interface BillingRegionSuggestion {
  country: string | null
  suggested: BillingAccount
  usAvailable: boolean
}

const model = defineModel<BillingAccount | undefined>()
const { t } = useI18n()
const visible = ref(false)

const options: Array<{ value: BillingAccount, title: string, description: string }> = [
  { value: 'us', title: t('billing-region-option-us'), description: t('billing-region-option-us-desc') },
  { value: 'ee', title: t('billing-region-option-ee'), description: t('billing-region-option-ee-desc') },
]

onMounted(async () => {
  const { data, error } = await invokeCapgoApi<BillingRegionSuggestion>('private/billing_region', { method: 'GET' })
  // Only US visitors get asked; everyone else keeps the server default.
  if (error || !data?.usAvailable || data.country !== 'US')
    return
  if (!model.value)
    model.value = data.suggested
  visible.value = true
})
</script>

<template>
  <div v-if="visible" data-test="billing-region-choice">
    <p id="billing-region-label" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
      <IconLandmark class="h-4 w-4 text-primary-500" />
      {{ t('billing-region-label') }}
    </p>
    <p id="billing-region-help" class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
      {{ t('billing-region-us-detected') }}
    </p>

    <div
      class="mt-3 grid gap-2 sm:grid-cols-2"
      role="radiogroup"
      aria-labelledby="billing-region-label"
      aria-describedby="billing-region-help"
    >
      <label
        v-for="option in options"
        :key="option.value"
        class="group cursor-pointer"
        :data-test="`billing-region-option-${option.value}`"
      >
        <input
          v-model="model"
          type="radio"
          name="billing-region"
          class="peer sr-only"
          :value="option.value"
        >
        <span
          class="flex min-h-16 items-center justify-between gap-3 rounded-xl border p-3 text-left transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-offset-slate-900"
          :class="model === option.value
            ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30'
            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900'"
        >
          <span class="min-w-0">
            <span class="block text-sm font-semibold">{{ option.title }}</span>
            <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">{{ option.description }}</span>
          </span>
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition"
            :class="model === option.value ? 'border-primary-500 bg-primary-500 text-white' : 'border-slate-300 bg-white text-transparent group-hover:border-slate-400 dark:border-white/20 dark:bg-slate-900'"
            aria-hidden="true"
          >
            <IconCheck class="h-3.5 w-3.5" />
          </span>
        </span>
      </label>
    </div>
  </div>
</template>
