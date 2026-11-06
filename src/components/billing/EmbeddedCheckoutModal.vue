<script setup lang="ts">
import type { StripeEmbeddedCheckout } from '@stripe/stripe-js'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BillingModal from '~/components/billing/BillingModal.vue'
import { getStripeJs } from '~/services/stripe'

const props = defineProps<{
  title: string
  description?: string
  clientSecret: string
  publishableKey: string
}>()

const emit = defineEmits<{
  close: []
  complete: []
}>()

const { t } = useI18n()
const container = ref<HTMLElement | null>(null)
const isLoading = ref(true)
const loadError = ref('')
let checkout: StripeEmbeddedCheckout | null = null
let disposed = false

onMounted(async () => {
  try {
    const stripe = await getStripeJs(props.publishableKey)
    if (!stripe)
      throw new Error('Stripe.js failed to load')
    const instance = await stripe.createEmbeddedCheckoutPage({
      clientSecret: props.clientSecret,
      onComplete: () => emit('complete'),
    })
    if (disposed || !container.value) {
      instance.destroy()
      return
    }
    checkout = instance
    checkout.mount(container.value)
  }
  catch (error) {
    console.error('Cannot mount embedded checkout', error)
    loadError.value = t('billing-stripe-load-error')
  }
  finally {
    isLoading.value = false
  }
})

onBeforeUnmount(() => {
  disposed = true
  checkout?.destroy()
  checkout = null
})
</script>

<template>
  <BillingModal :title="props.title" :description="props.description" size="checkout" flush headerless @close="emit('close')">
    <div v-if="isLoading" class="flex justify-center py-16" data-test="embedded-checkout-loading">
      <span class="d-loading d-loading-spinner d-loading-lg text-blue-500" />
    </div>
    <p v-if="loadError" class="mx-5 mb-5 mt-14 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
      {{ loadError }}
    </p>
    <!-- Full-bleed: no rounding or surface of our own so the Stripe iframe fills the modal body. -->
    <div ref="container" data-test="embedded-checkout" />
  </BillingModal>
</template>
