<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import iconEmail from '~icons/oui/email?raw'
import iconPassword from '~icons/ph/key?raw'
import { authGhostButtonClass, authPanelClass, authPrimaryButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import { getCapgoApiErrorCode, invokeCapgoApi } from '~/services/capgoApi'
import { useConsole } from '~/services/console'
import { getRecentEmailOtpVerification } from '~/services/emailOtp'
import { hideLoader } from '~/services/loader'
import { isNativeAppleLoginAvailable, signInWithApple } from '~/services/nativeAppleLogin'
import { openSupport } from '~/services/support'
import { useDialogV2Store } from '~/stores/dialogv2'
import { safeResetTurnstile } from '~/utils/turnstile'

const supabase = useConsole()
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
const isAppleAccount = ref(false)
const pendingAppleCode = ref('')
const pendingAppleUserId = ref('')
const appleMfaFactorId = ref('')
const appleMfaChallengeId = ref('')
const isEmailVerified = ref(true)
const isDeleteBlocked = computed(() => !isEmailVerified.value)

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
  const { data: sessionResult, error: sessionError } = await supabase.auth.getSession()
  if (sessionError || !sessionResult?.session) {
    isEmailVerified.value = true
    isLoadingSession.value = false
    return
  }
  isAppleAccount.value = isNativeAppleLoginAvailable(true)
    && sessionResult.session.user.identities?.some(identity => identity.provider === 'apple') === true
  isEmailVerified.value = !!sessionResult.session.user.email_confirmed_at
  isLoadingSession.value = false
}

async function ensureRecentEmailVerification(userId: string) {
  try {
    const { isVerified } = await getRecentEmailOtpVerification(supabase, userId)
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
          const supabaseClient = useConsole()
          isLoading.value = true

          try {
            if (isAppleAccount.value) {
              if (!pendingAppleCode.value || !pendingAppleUserId.value)
                return setErrors('delete-account', [t('invalid-auth')], {})
            }
            else {
              if (!pendingEmail.value || !pendingPassword.value) {
                isLoading.value = false
                return setErrors('delete-account', [t('invalid-auth')], {})
              }

              if (captchaKey.value && !confirmCaptchaToken.value) {
                isLoading.value = false
                return setErrors('delete-account', [t('captcha-required')], {})
              }

              const { error: reauthError } = await supabase.auth.reauthenticate({
                password: pendingPassword.value,
                captchaToken: captchaKey.value ? confirmCaptchaToken.value : undefined,
              })
              if (reauthError) {
                confirmCaptchaToken.value = ''
                safeResetTurnstile(confirmCaptchaComponent.value)
                isLoading.value = false
                if (reauthError.message.includes('captcha'))
                  toast.error(t('captcha-fail'))
                return setErrors('delete-account', [t('invalid-auth')], {})
              }
            }

            const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
            const userId = claimsData?.claims?.sub
            if (claimsError || !userId) {
              isLoading.value = false
              return setErrors('delete-account', [t('something-went-wrong-try-again-later')], {})
            }

            if (isAppleAccount.value && userId !== pendingAppleUserId.value)
              return setErrors('delete-account', [t('invalid-auth')], {})

            const { data: user } = await supabaseClient
              .from('users')
              .select()
              .eq('id', userId)
              .single()

            if (!user) {
              isLoading.value = false
              return setErrors('delete-account', [t('something-went-wrong-try-again-later')], {})
            }

            if (!await ensureRecentEmailVerification(userId)) {
              isLoading.value = false
              return false
            }

            if (isAppleAccount.value) {
              const { error: revokeError } = await invokeCapgoApi('private/revoke_apple_authorization', {
                client: supabase,
                body: { code: pendingAppleCode.value },
              })
              if (revokeError) {
                const errorCode = await getCapgoApiErrorCode(revokeError)
                return setErrors('delete-account', [t(errorCode === 'reauth_required' ? 'apple-delete-reauth-required' : 'apple-revoke-failed')], {})
              }
            }

            // Delete user using RPC function
            const { error: deleteError } = await supabase.rpc('delete_user')

            if (deleteError) {
              console.error('Delete error:', deleteError)
              if (deleteError.message?.includes('email_not_verified')) {
                isLoading.value = false
                await redirectToEmailVerification()
                return false
              }
              if (deleteError.message?.includes('reauth_required')) {
                isLoading.value = false
                return setErrors('delete-account', [t('invalid-auth')], {})
              }
              isLoading.value = false
              return setErrors('delete-account', [t('something-went-wrong-try-again-later')], {})
            }

            // Sign out and redirect to login page
            await supabase.auth.signOut()
            toast.success(t('account-deleted-successfully'))
            router.replace('/login')
          }
          catch (error) {
            console.error(error)
            isLoading.value = false
            return setErrors('delete-account', [t('something-went-wrong-try-again-later')], {})
          }
          finally {
            isLoading.value = false
            pendingAppleCode.value = ''
            pendingAppleUserId.value = ''
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
    pendingAppleCode.value = ''
    pendingAppleUserId.value = ''
    pendingEmail.value = ''
    pendingPassword.value = ''
    confirmCaptchaToken.value = ''
    safeResetTurnstile(confirmCaptchaComponent.value)
  }
  return dismissed
}

async function prepareAppleDeletionMfa() {
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (assuranceError)
    throw assuranceError
  if (assurance.currentLevel === 'aal1' && assurance.nextLevel === 'aal2') {
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors()
    if (factorsError)
      throw factorsError
    const factor = factors.all.find(factor => factor.status === 'verified')
    if (!factor)
      throw new Error('Missing MFA factor')
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.id })
    if (challengeError)
      throw challengeError
    appleMfaFactorId.value = factor.id
    appleMfaChallengeId.value = challenge.id
    return true
  }
  return false
}

async function startAppleDeletion() {
  if (isLoading.value || !isAppleAccount.value)
    return
  if (captchaKey.value && !turnstileToken.value) {
    setErrors('delete-account', [t('captcha-required')], {})
    return
  }
  isLoading.value = true
  pendingAppleCode.value = ''
  try {
    const { data: claims, error: claimsError } = await supabase.auth.getClaims()
    const userId = claims?.claims?.sub
    if (claimsError || !userId)
      throw new Error('Authentication required')
    if (!await ensureRecentEmailVerification(userId))
      return
    const result = await signInWithApple(supabase, turnstileToken.value || undefined, { reauthenticate: true })
    if (!result)
      return
    if (result.user.id !== userId) {
      await supabase.auth.signOut({ scope: 'local' })
      await router.replace('/login')
      throw new Error('Apple account does not match the account being deleted')
    }
    if (!result.authorizationCode)
      throw new Error('Missing Apple authorization code')
    pendingAppleCode.value = result.authorizationCode
    pendingAppleUserId.value = userId
    if (await prepareAppleDeletionMfa())
      return
    isLoading.value = false
    await deleteAccount()
  }
  catch {
    pendingAppleCode.value = ''
    toast.error(t('apple-login-failed'))
  }
  finally {
    turnstileToken.value = ''
    safeResetTurnstile(captchaComponent.value)
    isLoading.value = false
  }
}

function resetAppleDeletionAuthorization() {
  appleMfaFactorId.value = ''
  appleMfaChallengeId.value = ''
  pendingAppleCode.value = ''
  pendingAppleUserId.value = ''
}

async function verifyAppleDeletionMfa(form: { code: string }) {
  if (isLoading.value)
    return
  isLoading.value = true
  try {
    const { error } = await supabase.auth.mfa.verify({
      factorId: appleMfaFactorId.value,
      challengeId: appleMfaChallengeId.value,
      code: form.code.replaceAll(' ', ''),
    })
    if (error) {
      if (error.code === 'mfa_verification_failed') {
        toast.error(t('invalid-mfa-code'))
      }
      else {
        resetAppleDeletionAuthorization()
        toast.error(t('apple-login-failed'))
      }
      return
    }
    appleMfaFactorId.value = ''
    appleMfaChallengeId.value = ''
    isLoading.value = false
    await deleteAccount()
  }
  catch {
    resetAppleDeletionAuthorization()
    toast.error(t('apple-login-failed'))
  }
  finally {
    isLoading.value = false
  }
}

async function submit(form: { email: string, password: string }) {
  if (isDeleteBlocked.value) {
    return setErrors('delete-account', [t('email-not-verified')], {})
  }
  isLoading.value = true
  if (captchaKey.value && !turnstileToken.value) {
    isLoading.value = false
    setErrors('delete-account', [t('captcha-required')], {})
    return
  }
  const { data: current } = await supabase.auth.getSession()
  const { error } = current.session?.user.email?.toLowerCase() === form.email.toLowerCase()
    ? await supabase.auth.reauthenticate({ password: form.password, captchaToken: captchaKey.value ? turnstileToken.value : undefined })
    : await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
        options: captchaKey.value ? { captchaToken: turnstileToken.value } : undefined,
      })
  isLoading.value = false
  if (error) {
    console.error('error', error)
    setErrors('delete-account', [error.message], {})
    if (error.message.includes('captcha')) {
      safeResetTurnstile(captchaComponent.value)
      toast.error(t('captcha-fail'))
      return
    }
    toast.error(t('invalid-auth'))
  }
  else {
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
    const userId = claimsData?.claims?.sub
    if (!claimsError && !userId) {
      await router.replace({ path: '/login', query: { to: '/delete_account' } })
      return
    }
    if (claimsError || !userId) {
      isLoading.value = false
      return setErrors('delete-account', [t('something-went-wrong-try-again-later')], {})
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

    <div v-else-if="isAppleAccount" class="space-y-5">
      <p class="text-sm text-slate-600 dark:text-slate-300">
        {{ t('apple-delete-account-hint') }}
      </p>
      <FormKit v-if="appleMfaFactorId" id="delete-account" type="form" :actions="false" @submit="verifyAppleDeletionMfa">
        <FormKit
          name="code"
          type="text"
          :label="t('2fa-code')"
          inputmode="numeric"
          autocomplete="one-time-code"
          validation="required|length:6"
          :disabled="isLoading"
        />
        <button type="submit" :disabled="isLoading" :class="authPrimaryButtonClass">
          {{ t('verify') }}
        </button>
      </FormKit>
      <FormKit v-else id="delete-account" type="form" :actions="false" @submit="startAppleDeletion">
        <VueTurnstile v-if="captchaKey" ref="captchaComponent" v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
        <FormKitMessages />
        <AppleSignInButton :disabled="isLoading" :loading="isLoading" @click="startAppleDeletion" />
      </FormKit>
    </div>

    <FormKit v-else id="delete-account" type="form" :actions="false" @submit="submit">
      <div class="space-y-5 text-slate-500 dark:text-slate-300">
        <FormKit
          type="email"
          name="email"
          :disabled="isLoading"
          enterkeyhint="next"
          :prefix-icon="iconEmail"
          inputmode="email"
          :label="t('email')"
          autocomplete="email"
          validation="required:trim"
        />

        <div>
          <div class="flex justify-end">
            <router-link
              to="/forgot_password"
              class="text-sm font-medium text-orange-500 transition-all duration-200 hover:text-orange-600 hover:underline focus:text-orange-600"
            >
              {{ t('forgot') }} {{ t('password') }} ?
            </router-link>
          </div>
          <FormKit
            id="passwordInput"
            type="password"
            :placeholder="t('password')"
            name="password"
            :label="t('password')"
            :prefix-icon="iconPassword"
            :disabled="isLoading"
            validation="required:trim"
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

        <FormKitMessages />

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
