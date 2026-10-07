<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import { isNativeChromeEnabled } from '~/composables/useNativeChrome'
import 'vue-sonner/style.css'

// In the Capacitor app the native navbar covers the top: start toasts below it
// so their close button stays reachable. Sonner already adds the safe-area inset.
const mobileOffset = isNativeChromeEnabled
  ? { top: 'calc(var(--cap-native-navigation-top, 0px) - env(safe-area-inset-top, 0px) + 8px)' }
  : undefined

const toastOptions = ref({
  classes: {
    toast: 'top-safe!',
  },
})
</script>

<template>
  <Toaster
    rich-colors close-button position="top-right"
    data-test="toast"
    theme="light"
    :toast-options="toastOptions"
    :mobile-offset="mobileOffset"
  />
</template>
