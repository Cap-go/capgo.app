import { computed, ref } from 'vue'

// Shared across billing modals so a nested one does not re-enable the app early.
const openBillingModals = ref(0)

// Lets other prompts stay out of the way while a billing dialog is on screen.
export const billingModalOpen = computed(() => openBillingModals.value > 0)

// Make the app behind the dialog inert instead of using showModal(): the browser top layer
// would cover Stripe's 3DS challenge and toasts, which are appended outside this dialog.
export function setBillingModalOpen(open: boolean) {
  openBillingModals.value = Math.max(0, openBillingModals.value + (open ? 1 : -1))
  const app = document.getElementById('app')
  if (app)
    app.inert = billingModalOpen.value
}
