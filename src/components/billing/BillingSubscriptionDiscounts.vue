<script setup lang="ts">
import type { BillingDiscount } from '~/services/stripe'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatLocalDate } from '~/services/date'
import { formatStripeAmount, getBillingDiscounts } from '~/services/stripe'

const props = defineProps<{ orgId: string }>()
const { t } = useI18n()
const discounts = ref<BillingDiscount[]>([])
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

function discountLabel(discount: BillingDiscount) {
  if (discount.percentOff !== null)
    return t('billing-discount-percent', { amount: discount.percentOff })
  if (discount.amountOff !== null && discount.currency)
    return t('billing-discount-amount', { amount: formatStripeAmount(discount.amountOff, discount.currency) })
  return discount.name || t('billing-discount-active')
}

onMounted(async () => {
  try {
    const data = await getBillingDiscounts(props.orgId)
    if (!disposed)
      discounts.value = data.discounts
  }
  catch (error) {
    console.error('Cannot load subscription discounts', error)
  }
})
</script>

<template>
  <ul v-if="discounts.length" class="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300" data-test="billing-discounts">
    <li v-for="(discount, index) in discounts" :key="index">
      <span class="font-semibold">{{ discountLabel(discount) }}</span>
      <span v-if="discount.code"> · {{ discount.code }}</span>
      <span v-else-if="discount.name && discount.name !== discountLabel(discount)"> · {{ discount.name }}</span>
      <p v-if="discount.endsAt" class="mt-1 text-xs">
        {{ t('billing-discount-ends', { date: formatLocalDate(discount.endsAt) }) }}
      </p>
    </li>
  </ul>
</template>
