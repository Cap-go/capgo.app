<script setup lang="ts">
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import iconPassword from '~icons/heroicons/key?raw'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
// tabs handled by settings layout

const isLoading = ref(false)
const isVerifying = ref(false)
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
const mainStore = useMainStore()
const mfaCode = ref('')
const needsReauthentication = ref(false)
const turnstileToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const captchaComponent = ref<InstanceType<typeof VueTurnstile> | null>(null)
const { t } = useI18n()
const SUPABASE_MAX_PASSWORD_LENGTH = 72

function resetCaptcha() {
  captchaComponent.value?.reset()
  turnstileToken.value = ''
}
displayStore.NavTitle = t('password')

// Check if user needs to verify password for current org
const needsPasswordVerification = computed(() => {
  const org = organizationStore.currentOrganization
  return org?.password_policy_config?.enabled && org?.password_has_access === false
})

// Get current org's password policy (use defaults if no policy)
const passwordPolicy = computed(() => {
  const org = organizationStore.currentOrganization
  if (org?.password_policy_config?.enabled) {
    return {
      ...org.password_policy_config,
      min_length: Math.min(org.password_policy_config.min_length, SUPABASE_MAX_PASSWORD_LENGTH),
    }
  }
  // Default policy
  return {
    min_length: 6,
    require_uppercase: true,
    require_number: true,
    require_special: true,
  }
})

// Build dynamic validation rules based on org's password policy
const validationRules = computed(() => {
  const rules = ['required', `length:${passwordPolicy.value.min_length}`]

  if (passwordPolicy.value.require_uppercase) {
    rules.push('contains_uppercase')
  }
  // contains_alpha ensures at least one letter
  rules.push('contains_alpha')
  if (passwordPolicy.value.require_special) {
    rules.push('contains_symbol')
  }
  // Note: FormKit doesn't have contains_number, but contains_alpha + the regex validation in backend handles this

  return rules.join('|')
})

// Build dynamic help text based on org's password policy
const helpText = computed(() => {
  const requirements = []
  requirements.push(`${passwordPolicy.value.min_length} ${t('characters-minimum')}`)
  if (passwordPolicy.value.require_uppercase)
    requirements.push(t('one-uppercase'))
  if (passwordPolicy.value.require_number)
    requirements.push(t('one-number'))
  if (passwordPolicy.value.require_special)
    requirements.push(t('one-special-character'))

  return requirements.join(', ')
})

// Verify existing password meets org requirements (no password change needed)
async function verifyPassword(form: { current_password: string }) {
  if (isVerifying.value)
    return
  isVerifying.value = true

  try {
    const user = mainStore.user
    if (!user?.email) {
      setErrors('verify-password', [t('user-not-found')], {})
      return
    }

    const orgId = organizationStore.currentOrganization?.gid
    if (!orgId) {
      setErrors('verify-password', [t('no-organization-selected')], {})
      return
    }

    // Call the backend to validate password compliance
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/private/validate_password_compliance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
      },
      body: JSON.stringify({
        email: user.email,
        password: form.current_password,
        org_id: orgId,
        ...(turnstileToken.value ? { captcha_token: turnstileToken.value } : {}),
      }),
    })

    const result: { error?: string, message?: string } = await response.json()

    if (!response.ok) {
      if (result.error === 'captcha_failed') {
        toast.error(t('captcha-fail'))
        resetCaptcha()
      }
      else if (result.error === 'invalid_credentials') {
        setErrors('verify-password', [t('invalid-password')], {})
        resetCaptcha()
      }
      else if (result.error === 'password_does_not_meet_policy') {
        setErrors('verify-password', [t('password-does-not-meet-requirements')], {})
      }
      else {
        setErrors('verify-password', [result.message || t('verification-failed')], {})
      }
      return
    }

    toast.success(t('password-verified-successfully'))
    resetCaptcha()

    // Refresh org data to update access status
    await organizationStore.fetchOrganizations()

    form.current_password = ''
  }
  finally {
    isVerifying.value = false
  }
}

async function verifyCurrentPassword(currentPassword: string) {
  const user = mainStore.user
  if (!user?.email) {
    setErrors('change-pass', [t('user-not-found')], {})
    return false
  }

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
    options: turnstileToken.value
      ? { captchaToken: turnstileToken.value }
      : undefined,
  })

  if (signInError?.code === 'mfa_required') {
    return await runMfaChallenge()
  }

  if (signInError) {
    resetCaptcha()
    if (signInError.message.includes('captcha')) {
      toast.error(t('captcha-fail'))
    }
    else {
      setErrors('change-pass', [t('invalid-password')], {})
    }
    return false
  }

  return true
}

async function runMfaChallenge() {
  const { data: mfaFactors, error: mfaError } = await supabase.auth.mfa.listFactors()
  if (mfaError) {
    setErrors('forgot-password', [mfaError.message], {})
    console.error('Cannot get MFA factors', mfaError)
    return false
  }
  const factor = mfaFactors.all.find(factor => factor.status === 'verified')
  if (!factor) {
    setErrors('forgot-password', ['Cannot find MFA factor'], {})
    console.error('Cannot find MFA factors', mfaError)
    return false
  }

  const { data: challenge, error: errorChallenge } = await supabase.auth.mfa.challenge({ factorId: factor.id })
  if (errorChallenge) {
    setErrors('forgot-password', [errorChallenge.message], {})
    console.error('Cannot challenge MFA factor', errorChallenge)
    return false
  }

  mfaCode.value = ''
  dialogStore.openDialog({
    title: t('alert-2fa-required'),
    description: t('alert-2fa-required-message'),
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-confirm'),
        role: 'primary',
        handler: async () => {
          const { data: _verify, error: errorVerify } = await supabase.auth.mfa.verify({
            factorId: factor.id,
            challengeId: challenge.id,
            code: mfaCode.value.replaceAll(' ', ''),
          })
          if (errorVerify) {
            toast.error(t('invalid-mfa-code'))
            return false // Prevent dialog from closing
          }
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
  return true
}

async function ensureMfaIfNeeded() {
  const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const { currentLevel, nextLevel } = aal.data!
  if (nextLevel !== currentLevel)
    return await runMfaChallenge()
  return true
}

async function submit(form: { current_password?: string, password: string, password_confirm: string }) {
  if (isLoading.value)
    return
  isLoading.value = true

  if (needsReauthentication.value) {
    const currentPasswordValid = await verifyCurrentPassword(form.current_password ?? '')
    if (!currentPasswordValid) {
      isLoading.value = false
      return
    }
  }

  const mfaOk = await ensureMfaIfNeeded()
  if (!mfaOk) {
    isLoading.value = false
    return
  }
  const { error: updateError } = await supabase.auth.updateUser({ password: form.password })

  isLoading.value = false
  if (updateError) {
    if (updateError.code === 'reauthentication_needed' || updateError.code === 'reauthentication_not_valid') {
      needsReauthentication.value = true
      isLoading.value = false
      return
    }
    setErrors('change-pass', [t('account-password-error')], {})
  }
  else {
    needsReauthentication.value = false
    resetCaptcha()

    if (!organizationStore.currentOrganization?.password_has_access) {
      await organizationStore.fetchOrganizations()
    }

    const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' })
    if (signOutError) {
      setErrors('change-pass', [signOutError.message], {})
      return
    }

    toast.success(t('changed-password-suc'))
  }
  if (!updateError) {
    form.password = ''
    form.password_confirm = ''
    form.current_password = ''
  }
}
</script>

<template>
  <div>
    <div class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-lg md:pb-0 max-h-fit grow md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <!-- Password Verification Section (shown when user needs to verify) -->
      <div v-if="needsPasswordVerification" class="p-6 space-y-6 border-b border-slate-300 dark:border-slate-700">
        <!-- Info banner with requirements -->
        <div class="p-4 text-[#BB4D00] bg-[#FFFBEC] rounded-lg border border-orange-200">
          <h3 class="mb-3 text-lg font-semibold text-[#973C00]">
            {{ t('password-action-required') }}
          </h3>

          <!-- Password requirements list -->
          <div class="mb-4 p-3 bg-[#FFFBEC] rounded-md">
            <p class="text-sm font-medium text-[#973C00] mb-2">
              {{ t('password-must-meet') }}
            </p>
            <ul class="text-sm space-y-1">
              <li class="flex items-center gap-2">
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
                {{ passwordPolicy.min_length }} {{ t('characters-minimum') }}
              </li>
              <li v-if="passwordPolicy.require_uppercase" class="flex items-center gap-2">
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
                {{ t('one-uppercase') }}
              </li>
              <li v-if="passwordPolicy.require_number" class="flex items-center gap-2">
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
                {{ t('one-number') }}
              </li>
              <li v-if="passwordPolicy.require_special" class="flex items-center gap-2">
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
                {{ t('one-special-character') }}
              </li>
            </ul>
          </div>

          <!-- Instructions -->
          <div class="text-sm space-y-2">
            <p>
              <strong>{{ t('password-if-meets') }}</strong> {{ t('auth-verify-access-hint') }}
            </p>
            <p>
              <strong>{{ t('password-if-not-meets') }}</strong> {{ t('password-change-then-verify') }}
            </p>
          </div>
        </div>

        <FormKit id="verify-password" type="form" :actions="false" @submit="verifyPassword">
          <section>
            <h2 class="mb-4 text-xl font-bold dark:text-white text-slate-800">
              {{ t('verify-current-password') }}
            </h2>
            <div class="space-y-4">
              <FormKit
                type="password"
                name="current_password"
                :prefix-icon="iconPassword"
                autocomplete="current-password"
                outer-class="sm:w-1/2"
                :label="t('current-password')"
                :help="helpText"
                validation="required"
              />
            </div>
            <FormKitMessages />
          </section>
          <footer>
            <div class="flex flex-col py-5">
              <div class="flex self-start">
                <button
                  class="p-2 text-white bg-green-500 rounded-sm hover:bg-green-600 d-btn"
                  type="submit"
                >
                  <span v-if="!isVerifying" class="rounded-4xl">
                    {{ t('verify-password') }}
                  </span>
                  <Spinner v-else size="w-8 h-8" class="px-4" color="fill-gray-100 text-gray-200 dark:text-gray-600" />
                </button>
              </div>
            </div>
          </footer>
        </FormKit>
      </div>

      <!-- Change Password Section -->
      <FormKit id="change-pass" type="form" :actions="false" @submit="submit">
        <!-- Panel body -->
        <div class="p-6 space-y-6">
          <h2 class="mb-5 text-2xl font-bold dark:text-white text-slate-800">
            {{ t('account-password-heading') }}
          </h2>
          <!-- Personal Info -->
          <section>
            <div class="mt-5 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <FormKit
                v-if="needsReauthentication"
                type="password"
                name="current_password"
                :prefix-icon="iconPassword"
                autocomplete="current-password"
                outer-class="sm:w-full"
                :label="t('current-password')"
                validation="required"
                validation-visibility="live"
              />
              <FormKit
                type="password"
                name="password"
                :prefix-icon="iconPassword"
                autocomplete="new-password"
                outer-class="sm:w-1/2"
                :label="t('password')"
                :help="helpText"
                :validation="validationRules"
                validation-visibility="live"
              />
              <FormKit
                type="password"
                name="password_confirm"
                :prefix-icon="iconPassword"
                outer-class="sm:w-1/2"
                :label="t('confirm-password')"
                validation="required|confirm"
                validation-visibility="live"
                :validation-label="t('password-confirmatio')"
              />
            </div>
            <FormKitMessages />
          </section>
          <!-- Panel footer -->
          <footer>
            <div class="flex flex-col px-2 py-5 border-t md:px-6 border-slate-300">
              <div class="flex self-end">
                <button
                  class="p-2 ml-3 text-white bg-blue-500 rounded-sm hover:bg-blue-600 d-btn"
                  type="submit"
                  color="secondary"
                  shape="round"
                >
                  <span v-if="!isLoading" class="rounded-4xl">
                    {{ t('update') }}
                  </span>
                  <Spinner v-else size="w-8 h-8" class="px-4" color="fill-gray-100 text-gray-200 dark:text-gray-600" />
                </button>
              </div>
            </div>
          </footer>
        </div>
      </FormKit>
    </div>

    <div v-if="!!captchaKey" class="mt-4">
      <VueTurnstile ref="captchaComponent" v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
    </div>

    <!-- Teleport Content for 2FA Input -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('alert-2fa-required')" defer to="#dialog-v2-content">
      <div class="space-y-4">
        <div>
          <label for="mfa-code" class="block mb-2 text-sm font-medium">{{ t('enter-2fa-code') }}</label>
          <input
            id="mfa-code"
            v-model="mfaCode"
            type="text"
            placeholder="123456"
            :aria-label="t('enter-2fa-code')"
            class="w-full input input-bordered"
            maxlength="6"
            inputmode="numeric"
          >
          <div class="text-sm text-gray-500">
            {{ t('enter-the-6-digit-code-from-your-authenticator-app') }}
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<route lang="yaml">
path: /settings/account/change-password
meta:
  layout: settings
</route>
