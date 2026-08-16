<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconLoader from '~icons/lucide/loader-2'
import IconTriangleAlert from '~icons/lucide/triangle-alert'
import { authGhostButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import { openSupport } from '~/services/support'

const route = useRoute()
const { t } = useI18n()
const isRedirecting = ref(true)
const error = ref('')
const invalidConfirmationMessage = 'Invalid confirmation URL. Please check your email link.'
const redirectErrorMessage = 'Error redirecting to confirmation page. Please try again.'

// Get the allowed hostname from VITE_APP_URL
const allowedHost = (() => {
  try {
    return new URL(import.meta.env.VITE_APP_URL).hostname
  }
  catch {
    return ''
  }
})()

// Also allow Supabase host for confirmation URLs
const allowedSupabaseHost = (() => {
  try {
    return new URL(import.meta.env.VITE_SUPABASE_URL).hostname
  }
  catch {
    return ''
  }
})()

function isAllowedConfirmationUrl(urlValue: string) {
  const url = new URL(urlValue, window.location.origin)

  // Allow localhost in dev mode
  if (import.meta.env.DEV) {
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
      return true
  }

  // Only allow https
  if (url.protocol !== 'https:')
    return false

  // Only allow exact hostnames from VITE_APP_URL or VITE_SUPABASE_URL
  return url.hostname === allowedHost || url.hostname === allowedSupabaseHost
}
onMounted(() => {
  const confirmationUrl = route.query.confirmation_url as string

  if (!confirmationUrl) {
    isRedirecting.value = false
    error.value = invalidConfirmationMessage
    return
  }

  try {
    // Decode the URL if needed and redirect immediately
    const decodedUrl = decodeURIComponent(confirmationUrl)
    if (!isAllowedConfirmationUrl(decodedUrl)) {
      isRedirecting.value = false
      error.value = invalidConfirmationMessage
      return
    }
    window.location.href = decodedUrl
  }
  catch {
    isRedirecting.value = false
    error.value = redirectErrorMessage
  }
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    card-kicker="Secure redirect"
    card-title="Email confirmation"
    card-description="We only forward confirmation links to approved Capgo and Supabase hosts."
  >
    <div class="space-y-5 text-center">
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-slate-200/80 bg-slate-50/85 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.45)] dark:border-slate-700/80 dark:bg-slate-900/80">
        <component :is="isRedirecting ? IconLoader : IconTriangleAlert" class="h-8 w-8" :class="isRedirecting ? 'animate-spin text-[var(--color-azure-500)]' : 'text-red-500 dark:text-red-300'" />
      </div>

      <div v-if="isRedirecting" class="space-y-3">
        <p class="text-base font-semibold text-slate-900 dark:text-white">
          Redirecting to confirmation page...
        </p>
        <p class="text-sm leading-6 text-slate-500 dark:text-slate-300">
          Please wait while we redirect you to confirm your email address.
        </p>
      </div>

      <div v-else class="space-y-4">
        <div class="rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm font-medium text-red-700 dark:border-red-800/80 dark:bg-red-950/40 dark:text-red-200">
          {{ error }}
        </div>
        <p class="text-sm leading-6 text-slate-500 dark:text-slate-300">
          If this link is stale or broken, request a new confirmation email and try again.
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <router-link to="/resend_email" :class="authSecondaryButtonClass">
            {{ t('resend-email') }}
          </router-link>
          <router-link to="/login" :class="authSecondaryButtonClass">
            {{ t('back-to-login-page') }}
          </router-link>
        </div>
      </div>
    </div>

    <template #footer>
      <section class="mt-6 flex flex-col items-center">
        <div class="mx-auto">
          <LangSelector />
        </div>
        <button type="button" class="mt-3" :class="authGhostButtonClass" @click="openSupport">
          {{ t('support') }}
        </button>
      </section>
    </template>
  </AuthPageShell>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
