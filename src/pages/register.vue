<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import VueTurnstile from 'vue-turnstile'
import iconEmail from '~icons/oui/email?raw'
import iconPassword from '~icons/ph/key?raw'
import { authGhostButtonClass, authInlineLinkClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import { getCapgoApiErrorCode } from '~/services/capgoApi'
import { useConsole } from '~/services/console'
import { FunctionsHttpError } from '~/services/consoleClient'
import { registerAccount } from '~/services/registration'
import { openSupport } from '~/services/support'
import { parseWeb2AppArrival, rememberWeb2AppArrival, web2AppArrivalQuery } from '~/utils/web2appArrival'

const router = useRouter()
const route = useRoute()
const capgo = useConsole()
const { t } = useI18n()
const turnstileToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const isLoading = ref(false)

// Web2App arrivals (for example from the retired WebNativeApp site) keep their
// website through signup so onboarding can start on the Web2App path. The
// arrival is only stored once an account exists, so a visit without signup
// never forces a later account on this browser onto the Web2App intent.
const web2AppArrival = parseWeb2AppArrival(route.query)
const web2AppQuery = web2AppArrival ? web2AppArrivalQuery(web2AppArrival) : {}

if (window.location.host === 'console.capgo.app') {
  // do not allow to register on webapp on production
  window.location.href = `https://capgo.app/register/${window.location.search}`
}

async function submit(form: { password: string, email: string }) {
  if (isLoading.value)
    return

  isLoading.value = true
  try {
    const registered = await registerAccount(form.email, form.password, turnstileToken.value)
    const { error } = await capgo.auth.setSession(registered.session)
    if (error)
      throw error
    // Storage survives the /onboarding/name step that drops the query string.
    // Scoped to this account so another signup on the same browser cannot inherit it.
    if (web2AppArrival)
      rememberWeb2AppArrival(web2AppArrival, Date.now(), registered.user.id)
  }
  catch (error) {
    const code = await getCapgoApiErrorCode(error)
    let message = t('account-error')
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      const body = await error.context.clone().json().catch(() => null)
      if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
        message = body.message
    }
    setErrors('register-account', [code === 'account_deleted' ? t('used-to-create') : message], {})
    // Re-enable only after the error is shown, so a quick second click cannot start another signup.
    isLoading.value = false
    return
  }

  // The account exists and the user is signed in from here on: a navigation problem is not a
  // signup failure. Keep the spinner until onboarding has loaded, and fall back to a full page
  // load if the in-app navigation fails.
  try {
    const failure = await router.push({ path: '/dashboard', query: web2AppQuery })
    if (failure)
      isLoading.value = false
  }
  catch (navigationError) {
    console.error('Navigation after registration failed', navigationError)
    window.location.assign('/dashboard')
  }
}
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-2xl"
    :card-kicker="t('register-heading')"
    :card-title="t('create-a-free-account')"
  >
    <FormKit id="register-account" type="form" :actions="false" @submit="submit">
      <div class="grid gap-4 text-slate-500 dark:text-slate-300 md:grid-cols-2">
        <div class="md:col-span-2">
          <FormKitMessages data-test="form-error" />
        </div>

        <div class="md:col-span-2">
          <FormKit
            type="email"
            name="email"
            :prefix-icon="iconEmail"
            autofocus
            autocomplete="email"
            inputmode="email"
            enterkeyhint="next"
            validation="required:trim|email"
            :label="t('email')"
            data-test="email"
            :classes="{
              outer: 'mb-0!',
            }"
          />
        </div>

        <div class="md:col-span-2">
          <FormKit
            type="password"
            name="password"
            :prefix-icon="iconPassword"
            autocomplete="new-password"
            :label="t('password')"
            data-test="password"
            validation="required|length:6|contains_alpha|contains_uppercase|contains_lowercase|contains_numeric|contains_symbol"
            validation-visibility="dirty"
            :classes="{
              outer: 'mb-0!',
            }"
          />
        </div>

        <div v-if="captchaKey" class="md:col-span-2 overflow-hidden">
          <VueTurnstile v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
        </div>

        <div class="md:col-span-2">
          <button
            :disabled="isLoading"
            type="submit"
            data-test="submit"
            :class="authPrimaryButtonClass"
          >
            <span v-if="!isLoading">{{ t('register-next') }}</span>
            <Spinner v-else size="w-5 h-5" color="fill-gray-100 text-white/70" />
          </button>
        </div>

        <div class="md:col-span-2 text-center">
          <p class="text-xs leading-6 text-slate-500 dark:text-slate-400">
            {{ t('register-terms-disclaimer') }}
          </p>
        </div>

        <div class="md:col-span-2" :class="authPanelClass">
          <p class="text-sm text-slate-600 dark:text-slate-300">
            {{ t('already-account') }}
          </p>
          <router-link to="/login" :class="authInlineLinkClass">
            {{ t('back-to-login-page') }}
          </router-link>
        </div>
      </div>
    </FormKit>

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
