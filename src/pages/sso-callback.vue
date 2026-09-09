<script setup lang="ts">
import type { Session } from '@supabase/supabase-js'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconLoader from '~icons/lucide/loader-2'
import IconTriangleAlert from '~icons/lucide/triangle-alert'
import { authGhostButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import { useSSOProvisioning } from '~/composables/useSSOProvisioning'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { validateRedirectPath } from '~/utils/safeRedirect'

const route = useRoute()
const router = useRouter()
const supabase = useSupabase()
const { t } = useI18n()
const isLoading = ref(true)
const errorMessage = ref('')
const { provisionUser, error: provisionError } = useSSOProvisioning()

function getSsoCallbackParams() {
  const hashParams = new URLSearchParams(globalThis.location.hash.replace('#', ''))
  const queryParams = new URLSearchParams(globalThis.location.search)

  return {
    accessToken: hashParams.get('access_token') ?? queryParams.get('access_token') ?? '',
    refreshToken: hashParams.get('refresh_token') ?? queryParams.get('refresh_token') ?? '',
    code: queryParams.get('code') ?? hashParams.get('code') ?? '',
    error: queryParams.get('error') ?? hashParams.get('error') ?? '',
    errorDescription: queryParams.get('error_description') ?? hashParams.get('error_description') ?? '',
  }
}

function clearAuthParamsFromUrl() {
  const parsedUrl = new URL(globalThis.location.href)
  const hashParams = new URLSearchParams(parsedUrl.hash.replace('#', ''))

  parsedUrl.searchParams.delete('access_token')
  parsedUrl.searchParams.delete('refresh_token')
  hashParams.delete('access_token')
  hashParams.delete('refresh_token')

  const nextHash = hashParams.toString()
  parsedUrl.hash = nextHash ? `#${nextHash}` : ''

  globalThis.history.replaceState({}, '', parsedUrl.toString())
}

async function completeSsoLogin() {
  const { accessToken, refreshToken, code, error, errorDescription } = getSsoCallbackParams()
  clearAuthParamsFromUrl()

  if (error) {
    isLoading.value = false
    errorMessage.value = errorDescription || error
    toast.error(errorMessage.value)
    return
  }

  try {
    let session: Session | null = null

    if (accessToken && refreshToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })

      if (error) {
        isLoading.value = false
        errorMessage.value = error.message || 'Failed to authenticate with SSO'
        toast.error(errorMessage.value)
        return
      }

      session = data.session
    }
    else if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)

      if (error) {
        isLoading.value = false
        errorMessage.value = error.message || 'Failed to authenticate with SSO'
        toast.error(errorMessage.value)
        return
      }

      session = data.session
    }
    else {
      isLoading.value = false
      errorMessage.value = 'No authentication data found'
      return
    }

    if (session) {
      const { merged, alreadyMember } = await provisionUser(session)
      if (merged) {
        // The duplicate SSO user was merged into the existing account.
        // The current session is now invalid — sign out and redirect to login.
        await supabase.auth.signOut()
        router.replace('/login?message=sso_account_linked')
        return
      }
      if (provisionError.value) {
        await supabase.auth.signOut()
        isLoading.value = false
        errorMessage.value = provisionError.value
        toast.error(provisionError.value)
        return
      }

      if (!alreadyMember) {
        toast.success(t('sso-linked-success'))
      }
    }

    // Validate redirect path to prevent open redirect
    const redirectTo = route.query.to as string | undefined
    const validatedPath = validateRedirectPath(redirectTo)
    router.replace(validatedPath)
  }
  catch (err) {
    isLoading.value = false
    errorMessage.value = err instanceof Error ? err.message : 'An unexpected error occurred'
    toast.error(errorMessage.value)
  }
}

onMounted(completeSsoLogin)
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    card-kicker="SSO"
    :card-title="t('continue-with-sso')"
    :card-description="t('login-to-your-account')"
  >
    <div class="space-y-5 text-center text-slate-500 dark:text-slate-300">
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-slate-200/80 bg-slate-50/85 shadow-[0_20px_40px_-32px_rgba(15,23,42,0.45)] dark:border-slate-700/80 dark:bg-slate-900/80">
        <component :is="isLoading ? IconLoader : IconTriangleAlert" class="h-8 w-8" :class="isLoading ? 'animate-spin text-[var(--color-azure-500)]' : 'text-rose-500 dark:text-rose-300'" />
      </div>

      <div v-if="isLoading" class="space-y-3">
        <p class="text-base font-semibold text-slate-900 dark:text-white">
          {{ t('continue-with-sso') }}
        </p>
        <p class="text-sm leading-6">
          {{ t('login-to-your-account') }}
        </p>
      </div>

      <div v-else class="space-y-4">
        <div class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm font-medium text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200">
          {{ errorMessage }}
        </div>
        <p class="text-sm leading-6">
          {{ t('something-went-wrong-try-again-later') }}
        </p>
        <router-link to="/login" :class="authSecondaryButtonClass">
          {{ t('back-to-login-page') }}
        </router-link>
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
