<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import VueTurnstile from 'vue-turnstile'
import iconEmail from '~icons/oui/email?raw'
import iconPassword from '~icons/ph/key?raw'
import { authGhostButtonClass, authInlineLinkClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import { getCapgoApiErrorCode } from '~/services/capgoApi'
import { registerAccount } from '~/services/registration'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'

const router = useRouter()
const supabase = useSupabase()
const { t } = useI18n()
const turnstileToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const isLoading = ref(false)

if (window.location.host === 'console.capgo.app') {
  // do not allow to register on webapp on production
  window.location.href = 'https://capgo.app/register/'
}

async function submit(form: { password: string, email: string }) {
  if (isLoading.value)
    return

  isLoading.value = true
  try {
    const registered = await registerAccount(form.email, form.password, turnstileToken.value)
    const { error } = await supabase.auth.setSession(registered.session)
    if (error)
      throw error
    router.push('/dashboard')
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
  }
  finally {
    isLoading.value = false
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

        <FormKit
          type="password"
          name="password"
          :prefix-icon="iconPassword"
          autocomplete="new-password"
          :label="t('password')"
          data-test="password"
          validation="required|length:6|contains_alpha|contains_uppercase|contains_lowercase|contains_numeric|contains_symbol"
          validation-visibility="dirty"
        />
        <FormKit
          type="password"
          name="password_confirm"
          :prefix-icon="iconPassword"
          :label="t('confirm-password')"
          autocomplete="new-password"
          data-test="confirm-password"
          validation="required|confirm"
          validation-visibility="dirty"
          :validation-label="t('password-confirmatio')"
        />

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
