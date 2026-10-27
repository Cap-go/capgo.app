<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconLoader from '~icons/lucide/loader-2'
import IconTriangleAlert from '~icons/lucide/triangle-alert'
import { authGhostButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import { defaultApiHost } from '~/services/console'
import { resolveConsoleApiBase } from '~/services/consoleAuth'
import { replaceDocument } from '~/services/documentNavigation'
import { openSupport } from '~/services/support'
import { getAllowedConfirmationHosts, resolveConfirmationUrl } from '~/utils/safeRedirect'

const route = useRoute()
const { t } = useI18n()
const isRedirecting = ref(true)
const error = ref('')
const allowedConfirmationHosts = getAllowedConfirmationHosts()
onMounted(() => {
  try {
    const confirmationUrl = resolveConfirmationUrl(route.query, {
      allowedHosts: allowedConfirmationHosts,
      allowLocalDev: import.meta.env.DEV,
      apiHost: resolveConsoleApiBase(defaultApiHost),
    })
    if (!confirmationUrl) {
      isRedirecting.value = false
      error.value = t('confirm-email-invalid-url')
      return
    }
    replaceDocument(confirmationUrl)
  }
  catch {
    isRedirecting.value = false
    error.value = t('confirm-email-redirect-error')
  }
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    :card-kicker="t('confirm-email-kicker')"
    :card-title="t('confirm-email-title')"
    :card-description="t('confirm-email-description')"
  >
    <div class="space-y-5 text-center">
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-slate-200/80 bg-slate-50/85 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.45)] dark:border-slate-700/80 dark:bg-slate-900/80">
        <component :is="isRedirecting ? IconLoader : IconTriangleAlert" class="h-8 w-8" :class="isRedirecting ? 'animate-spin text-[var(--color-azure-500)]' : 'text-red-500 dark:text-red-300'" />
      </div>

      <div v-if="isRedirecting" class="space-y-3">
        <p class="text-base font-semibold text-slate-900 dark:text-white">
          {{ t('confirm-email-redirecting') }}
        </p>
        <p class="text-sm leading-6 text-slate-500 dark:text-slate-300">
          {{ t('confirm-email-redirecting-hint') }}
        </p>
      </div>

      <div v-else class="space-y-4">
        <div class="rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm font-medium text-red-700 dark:border-red-800/80 dark:bg-red-950/40 dark:text-red-200">
          {{ error }}
        </div>
        <p class="text-sm leading-6 text-slate-500 dark:text-slate-300">
          {{ t('confirm-email-stale-link') }}
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
