<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconPassword from '~icons/ph/key'
import { authGhostButtonClass, authPanelClass, authPrimaryButtonClass } from '~/components/auth/pageStyles'
import FormField from '~/components/forms/FormField.vue'
import { useConsole } from '~/services/console'
import { openSupport } from '~/services/support'
import { rules, validateField } from '~/utils/formValidation'

const isLoading = ref(false)
const capgo = useConsole()

const { t } = useI18n()

const router = useRouter()
const route = useRoute('/onboarding/set_password')

const password = ref('')
const passwordConfirm = ref('')
const submitted = ref(false)
const formErrors = ref<string[]>([])
// The previous `contain_*` rule names were never recognized by the validator, so only length is enforced.
const passwordErrors = computed(() => validateField(password.value, [rules.required(t('password')), rules.length(t('password'), 6)]))
const passwordConfirmErrors = computed(() => validateField(passwordConfirm.value, [
  rules.required(t('password-confirmatio')),
  rules.confirm(t('password-confirmatio'), () => password.value),
]))

async function signInUser() {
  if (!route.hash) {
    router.push('/login')
    return
  }
  const queryString = route.hash.replace('#', '')
  const urlParams = new URLSearchParams(queryString)
  const refresh_token = urlParams.get('refresh_token')
  if (!refresh_token) {
    router.push('/login')
    return
  }
  await capgo.auth.refreshSession({
    refresh_token: refresh_token ?? '',
  })
}

async function submit(form: { password: string }) {
  isLoading.value = true

  const { error: updateError } = await capgo.auth.updateUser({ password: form.password })
  isLoading.value = false
  if (updateError) {
    formErrors.value = [updateError.message]
    return
  }

  const { error: signOutError } = await capgo.auth.signOut({ scope: 'others' })
  if (signOutError) {
    formErrors.value = [signOutError.message]
    return
  }
  toast.success(t('changed-password-suc'))
  router.replace('/dashboard')
}

function onSubmit() {
  submitted.value = true
  formErrors.value = []
  if (passwordErrors.value.length || passwordConfirmErrors.value.length)
    return
  return submit({ password: password.value })
}

watchEffect(async () => {
  if (route && route.path === '/onboarding/set_password')
    await signInUser()
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    :card-kicker="t('password-heading')"
    :card-title="t('password-heading')"
    :card-description="t('enter-your-new-passw')"
  >
    <form id="set-password" novalidate @submit.prevent="onSubmit">
      <div class="space-y-5 text-slate-500 dark:text-slate-300">
        <ul v-if="formErrors.length" role="alert" class="mb-1.5">
          <li v-for="error in formErrors" :key="error" class="text-xs text-red-600 dark:text-red-400">
            {{ error }}
          </li>
        </ul>
        <FormField
          v-model="password"
          type="password"
          name="password"
          :prefix-icon="IconPassword"
          autocomplete="new-password"
          enterkeyhint="send"
          :disabled="isLoading"
          :label="t('password')"
          :help="t('6-characters-minimum')"
          :errors="passwordErrors"
          validation-visibility="dirty"
          :submitted="submitted"
        />

        <FormField
          v-model="passwordConfirm"
          type="password"
          name="password_confirm"
          :prefix-icon="IconPassword"
          autocomplete="new-password"
          :disabled="isLoading"
          :label="t('confirm-password')"
          :help="t('confirm-password')"
          :errors="passwordConfirmErrors"
          validation-visibility="dirty"
          :submitted="submitted"
        />

        <div>
          <button type="submit" :disabled="isLoading" :aria-busy="isLoading ? 'true' : 'false'" :class="authPrimaryButtonClass">
            <svg v-if="isLoading" class="inline-block mr-1 h-5 w-5 animate-spin align-middle text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {{ t('validate') }}
          </button>
        </div>

        <div :class="authPanelClass">
          <router-link to="/login" class="text-sm font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]">
            {{ t('back-to-login-page') }}
          </router-link>
        </div>
      </div>
    </form>

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
