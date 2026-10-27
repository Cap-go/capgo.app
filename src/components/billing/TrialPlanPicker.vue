<script setup lang="ts">
/**
 * Compact plan list for the trial card / offer flow. Collapsed by default: the
 * onboarding plan stays selected and a "Change plan" control reveals Solo /
 * Maker / Team only when the user wants a different one.
 */
import type { TrialPlanOption } from '~/services/stripe'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatStripeAmount } from '~/services/stripe'

const props = defineProps<{
  modelValue: string
  options: TrialPlanOption[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [productId: string]
}>()

const { t } = useI18n()
const groupId = useId()
const expanded = ref(false)

const selected = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})

function priceLabel(option: TrialPlanOption) {
  return formatStripeAmount(option.amount, option.currency)
}

function openPicker() {
  if (!props.disabled)
    expanded.value = true
}
</script>

<template>
  <div class="mt-4" data-test="trial-plan-picker">
    <button
      v-if="!expanded"
      type="button"
      class="d-btn d-btn-ghost d-btn-sm h-auto min-h-0 px-0 text-sm font-medium text-blue-600 hover:bg-transparent hover:underline dark:text-blue-400"
      :disabled="disabled"
      data-test="trial-plan-change"
      @click="openPicker"
    >
      {{ t('trial-plan-change') }}
    </button>
    <fieldset v-else class="space-y-2" :disabled="disabled">
      <legend class="text-sm font-medium text-slate-800 dark:text-slate-100">
        {{ t('trial-plan-picker-label') }}
      </legend>
      <p class="text-xs leading-5 text-slate-500 dark:text-slate-400">
        {{ t('trial-plan-picker-hint') }}
      </p>
      <div class="mt-2 space-y-2" role="radiogroup" :aria-label="t('trial-plan-picker-label')">
        <label
          v-for="option in options"
          :key="option.productId"
          class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors"
          :class="selected === option.productId
            ? 'border-blue-500 bg-blue-50/80 dark:border-blue-400 dark:bg-blue-950/40'
            : 'border-slate-200 hover:border-slate-300 dark:border-slate-600 dark:hover:border-slate-500'"
          :data-test="`trial-plan-option-${option.planName.toLowerCase()}`"
        >
          <span class="flex min-w-0 items-center gap-2.5">
            <input
              v-model="selected"
              type="radio"
              class="d-radio d-radio-sm d-radio-primary"
              :name="groupId"
              :value="option.productId"
              :disabled="disabled"
            >
            <span class="truncate font-medium text-slate-900 dark:text-white">
              {{ option.planName }}
            </span>
          </span>
          <span class="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
            <span v-if="option.regularAmount" data-test="trial-plan-regular-price" class="mr-1 text-slate-400 line-through dark:text-slate-500" :title="t('plans-regional-discount-requirement-generic')">
              {{ formatStripeAmount(option.regularAmount, option.currency) }}
            </span>
            {{ priceLabel(option) }}/{{ t('mo') }}
          </span>
        </label>
      </div>
    </fieldset>
  </div>
</template>
