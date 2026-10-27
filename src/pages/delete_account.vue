<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconEmail from '~icons/oui/email'
import IconPassword from '~icons/ph/key'
import { authGhostButtonClass, authPanelClass, authPrimaryButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import FormField from '~/components/forms/FormField.vue'
import VueTurnstile from '~/components/VueTurnstile.vue'
import { useConsole } from '~/services/console'
import { getRecentEmailOtpVerification } from '~/services/emailOtp'
import { hideLoader } from '~/services/loader'
import { openSupport } from '~/services/support'
import { useDialogV2Store } from '~/stores/dialogv2'
import { rules, validateField } from '~/utils/formValidation'
import { safeResetTurnstile } from '~/utils/turnstile'

const capgo = useConsole()
const dialogStore = useDialogV2Store()
const isLoading = ref(false)
const pendingEmail = ref('')
const pendingPassword = ref('')
const turnstileToken = ref('')
const confirmCaptchaToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const captchaComponent = ref<InstanceType<typeof VueTurnstile> | null>(null)
const confirmCaptchaComponent = ref<InstanceType<typeof VueTurnstile> | null>(null)
const { t } = useI18n()
const router = useRouter()
const isLoadingSession = ref(true)
const isEmailVerified = ref(true)
const isDeleteBlocked = computed(() => !isEmailVerified.value)
const email = ref('')
const password = ref('')
const submitted = ref(false)
const formErrors = ref<string[]>([])
const emailErrors = computed(() => validateField(email.value, [rules.required(t('email'), { trim: true })]))
const passwordErrors = computed(() => validateField(password.value, [rules.required(t('password'), { trim: true })]))

/** Shows a form-level error above the submit button. */
function setFormError(message: string) {
  formErrors.value = [message]
}

async function redirectToEmailVerification() {
  await router.push({
    path: '/resend_email',
    query: {
      reason: 'email_not_verified',
      return_to: '/delete_account',
    },
  })
}

async function checkEmailVerification() {
  isLoadingSession.value = true
  const { data: sessionResult, error: sessionError } = await capgo.auth.getSession()
  if (sessionError || !sessionResult?.session) {
    isEmailVerified.value = true
    isLoadingSession.value = false
    return
  }
  isEmailVerified.value = !!sessionResult.session.user.email_confirmed_at
  isLoadingSession.value = false
}

async function ensureRecentEmailVerification(userId: string) {
  try {
    const { isVerified } = await getRecentEmailOtpVerification(capgo, userId)
    if (isVerified)
      return true
  }
  catch (error) {
    console.error('Cannot load email OTP verification state', error)
    toast.error(t('something-went-wrong-try-again-later'))
    return false
  }

  await redirectToEmailVerification()
  return false
}

async function deleteAccount() {
  dialogStore.openDialog({
    id: 'delete-account-confirm',
    title: t('are-u-sure'),
    buttons: [
      {
        text: t('button-remove'),
        role: 'danger',
        handler: async () => {
          const capgoClient = useConsole()
          isLoading.value = true

          try {
            if (!pendingEmail.value || !pendingPassword.value) {
              isLoading.value = false
              return setFormError(t('invalid-auth'))
            }

            if (captchaKey.value && !confirmCaptchaToken.value) {
              isLoading.value = false
              return setFormError(t('captcha-required'))
            }

            const { error: reauthError } = await capgo.auth.signInWithPassword({
              email: pendingEmail.value,
              password: pendingPassword.value,
              options: captchaKey.value ? { captchaToken: confirmCaptchaToken.value } : undefined,
            })
            if (reauthError) {
              confirmCaptchaToken.value = ''
              safeResetTurnstile(confirmCaptchaComponent.value)
              isLoading.value = false
              if (reauthError.message.includes('captcha'))
                toast.error(t('captcha-fail'))
              return setFormError(t('invalid-auth'))
            }

            const { data: claimsData, error: claimsError } = await capgo.auth.getClaims()
            const userId = claimsData?.claims?.sub
            if (claimsError || !userId) {
              isLoading.value = false
              return setFormError(t('something-went-wrong-try-again-later'))
            }

            const { data: user } = await capgoClient
              .from('users')
              .select()
              .eq('id', userId)
              .single()

            if (!user) {
              isLoading.value = false
              return setFormError(t('something-went-wrong-try-again-later'))
            }

            if (!await ensureRecentEmailVerification(userId)) {
              isLoading.value = false
              return false
            }

            // Delete user using RPC function
            const { error: deleteError } = await capgo.rpc('delete_user')

            if (deleteError) {
              console.error('Delete error:', deleteError)
              if (deleteError.message?.includes('email_not_verified')) {
                isLoading.value = false
                await redirectToEmailVerification()
                return false
              }
              if (deleteError.message?.includes('reauth_required')) {
                isLoading.value = false
                return setFormError(t('invalid-auth'))
              }
              isLoading.value = false
              return setFormError(t('something-went-wrong-try-again-later'))
            }

            // Sign out and redirect to login page
            await capgo.auth.signOut()
            toast.success(t('account-deleted-successfully'))
            router.replace('/login')
          }
          catch (error) {
            console.error(error)
            isLoading.value = false
            return setFormError(t('something-went-wrong-try-again-later'))
          }
          finally {
            isLoading.value = false
            pendingEmail.value = ''
            pendingPassword.value = ''
            confirmCaptchaToken.value = ''
            safeResetTurnstile(confirmCaptchaComponent.value)
          }
        },
      },
      {
        text: t('button-cancel'),
        role: 'cancel',
        handler: () => {
          console.log('Cancel clicked')
        },
      },
    ],
  })
  const dismissed = await dialogStore.onDialogDismiss()
  if (dismissed) {
    pendingEmail.value = ''
    pendingPassword.value = ''
    confirmCaptchaToken.value = ''
    safeResetTurnstile(confirmCaptchaComponent.value)
  }
  return dismissed
}

async function submit(form: { email: string, password: string }) {
  if (isDeleteBlocked.value) {
    return setFormError(t('email-not-verified'))
  }
  isLoading.value = true
  if (captchaKey.value && !turnstileToken.value) {
    isLoading.value = false
    setFormError(t('captcha-required'))
    return
  }
  const { error } = await capgo.auth.signInWithPassword({
    email: form.email,
    password: form.password,
    options: captchaKey.value ? { captchaToken: turnstileToken.value } : undefined,
  })
  isLoading.value = false
  if (error) {
    console.error('error', error)
    setFormError(error.message)
    if (error.message.includes('captcha')) {
      safeResetTurnstile(captchaComponent.value)
      toast.error(t('captcha-fail'))
      return
    }
    toast.error(t('invalid-auth'))
  }
  else {
    const { data: claimsData, error: claimsError } = await capgo.auth.getClaims()
    const userId = claimsData?.claims?.sub
    if (claimsError || !userId) {
      isLoading.value = false
      return setFormError(t('something-went-wrong-try-again-later'))
    }

    if (!await ensureRecentEmailVerification(userId)) {
      isLoading.value = false
      return
    }

    pendingEmail.value = form.email
    pendingPassword.value = form.password
    turnstileToken.value = ''
    safeResetTurnstile(captchaComponent.value)
    // delete account
    deleteAccount()
  }
}

function onSubmit() {
  submitted.value = true
  formErrors.value = []
  if (emailErrors.value.length || passwordErrors.value.length)
    return
  return submit({ email: email.value, password: password.value })
}

onMounted (() => {
  checkEmailVerification()
  hideLoader()
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    :card-kicker="t('leaving')"
    :card-title="t('delete-your-account')"
  >
    <div v-if="isLoadingSession" class="flex justify-center py-10">
      <CapgoLoader size="w-14 h-14" :label="t('loading')" class="my-auto" />
    </div>

    <div
      v-else-if="isDeleteBlocked"
      class="overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/90 p-3 text-amber-900 dark:border-amber-700/70 dark:bg-amber-900/25 dark:text-amber-100"
    >
      <p class="font-semibold">
        {{ t('email-not-verified') }}
      </p>
      <p class="mt-2 text-sm leading-6">
        {{ t('delete-account-verify-hint') }}
      </p>
      <router-link
        :to="{ path: '/resend_email', query: { reason: 'email_not_verified', return_to: '/delete_account' } }"
        class="mt-4"
        :class="authSecondaryButtonClass"
      >
        {{ t('validate-email') }}
      </router-link>
    </div>

    <form v-else id="delete-account" novalidate @submit.prevent="onSubmit">
      <div class="space-y-5 text-slate-500 dark:text-slate-300">
        <FormField
          v-model="email"
          type="email"
          name="email"
          :disabled="isLoading"
          enterkeyhint="next"
          :prefix-icon="IconEmail"
          inputmode="email"
          :label="t('email')"
          autocomplete="email"
          :errors="emailErrors"
          :submitted="submitted"
        />

        <div>
          <div class="flex justify-end">
            <router-link
              to="/forgot_password"
              class="text-sm font-medium text-orange-500 transition-all duration-200 hover:text-orange-600 hover:underline focus:text-orange-600"
            >
              {{ t('forgot-password') }}
            </router-link>
          </div>
          <FormField
            id="passwordInput"
            v-model="password"
            type="password"
            :placeholder="t('password')"
            name="password"
            :label="t('password')"
            :prefix-icon="IconPassword"
            :disabled="isLoading"
            :errors="passwordErrors"
            :submitted="submitted"
            enterkeyhint="send"
            autocomplete="current-password"
          />
        </div>

        <div v-if="captchaKey" class="space-y-2 overflow-hidden">
          <label class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ t('captcha') }}
          </label>
          <VueTurnstile ref="captchaComponent" v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
        </div>

        <ul v-if="formErrors.length" role="alert" class="mb-1.5">
          <li v-for="error in formErrors" :key="error" class="text-xs text-red-600 dark:text-red-400">
            {{ error }}
          </li>
        </ul>

        <div>
          <button
            type="submit"
            :disabled="isLoading"
            :aria-busy="isLoading ? 'true' : 'false'"
            :class="authPrimaryButtonClass"
          >
            <svg
              v-if="isLoading"
              class="mr-1 inline-block h-5 w-5 animate-spin align-middle text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            {{ t('delete-account-0') }}
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

    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'delete-account-confirm'" to="#dialog-v2-content" defer>
      <div v-if="captchaKey" class="mt-4">
        <label class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-200">
          {{ t('captcha') }}
        </label>
        <VueTurnstile
          ref="confirmCaptchaComponent"
          v-model="confirmCaptchaToken"
          size="flexible"
          :site-key="captchaKey"
        />
      </div>
    </Teleport>
  </AuthPageShell>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
