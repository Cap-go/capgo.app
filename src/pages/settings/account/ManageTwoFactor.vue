<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import { formatLocalDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const dialogStore = useDialogV2Store()
const displayStore = useDisplayStore()
const route = useRoute()
const router = useRouter()

displayStore.NavTitle = t('manage-2fa')

const isLoading = ref(true)
const mfaEnabled = ref(false)
const mfaFactorId = ref('')
const mfaSetupDate = ref<string | null>(null)
const otpAlreadyVerified = ref(false)

// Stepper state
const currentStep = ref(1)
const totalSteps = 5

// Step 1: CAPTCHA
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const captchaToken = ref('')
const savedCaptchaToken = ref('')
const captchaRef = ref<InstanceType<typeof VueTurnstile> | null>(null)

// Step 2 & 3: Email OTP
const otpEmail = computed(() => main.auth?.email ?? main.user?.email ?? '')
const otpSending = ref(false)
const otpVerificationCode = ref('')
const otpVerificationLoading = ref(false)

// Step 4 & 5: TOTP
const mfaQRCode = ref('')
const enrolledFactorId = ref('')
const mfaVerificationCode = ref('')
const mfaVerifying = ref(false)

const stepLabels = computed(() => [
  t('2fa-step-captcha'),
  t('2fa-step-send-code'),
  t('2fa-step-enter-code'),
  t('2fa-step-scan-qr'),
  t('2fa-step-verify-totp'),
])

const setupDateLabel = computed(() => {
  if (!mfaSetupDate.value)
    return ''
  return formatLocalDate(mfaSetupDate.value)
})

watch(captchaToken, (token) => {
  if (token && currentStep.value === 1) {
    savedCaptchaToken.value = token
    currentStep.value = 2
  }
})

async function sendOtpVerification() {
  if (!otpEmail.value || otpSending.value)
    return

  otpSending.value = true
  const { error } = await supabase.auth.signInWithOtp({
    email: otpEmail.value,
    options: {
      shouldCreateUser: false,
      captchaToken: savedCaptchaToken.value || undefined,
    },
  })
  otpSending.value = false

  savedCaptchaToken.value = ''

  if (error) {
    toast.error(t('verification-failed'))
    console.error('Cannot send email OTP', error)
    return
  }

  otpVerificationCode.value = ''
  toast.success(t('email-otp-sent'))
  currentStep.value = 3
}

async function verifyOtpForMfa() {
  if (!otpEmail.value || !main.auth?.id)
    return

  const token = otpVerificationCode.value.replaceAll(' ', '')
  if (!token) {
    toast.error(t('email-otp-code-required'))
    return
  }
  if (otpVerificationLoading.value)
    return

  otpVerificationLoading.value = true
  const { data, error: verifyError } = await supabase.functions.invoke('private/verify_email_otp', {
    body: { token },
  })
  otpVerificationLoading.value = false

  if (verifyError || !data?.verified_at) {
    toast.error(t('verification-failed'))
    console.error('Cannot verify email OTP', verifyError)
    return
  }

  toast.success(t('email-otp-verified'))
  await enrollTotp()
}

async function enrollTotp() {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
  if (error) {
    toast.error(t('mfa-fail'))
    console.error(error)
    return
  }

  mfaQRCode.value = data.totp.qr_code
  enrolledFactorId.value = data.id
  currentStep.value = 4
}

function proceedToVerify() {
  currentStep.value = 5
}

async function verifyAndEnable() {
  if (mfaVerifying.value)
    return

  const code = mfaVerificationCode.value.replaceAll(' ', '').trim()
  if (!code) {
    toast.error(t('email-otp-code-required'))
    return
  }

  mfaVerifying.value = true

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: enrolledFactorId.value,
  })

  if (challengeError) {
    toast.error(t('mfa-fail'))
    console.error('Cannot create MFA challenge', challengeError)
    mfaVerifying.value = false
    return
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: enrolledFactorId.value,
    challengeId: challenge.id,
    code,
  })

  mfaVerifying.value = false

  if (verifyError) {
    toast.error(t('mfa-invalid-code'))
    return
  }

  toast.success(t('mfa-enabled'))
  mfaEnabled.value = true
  mfaFactorId.value = enrolledFactorId.value
  mfaSetupDate.value = new Date().toISOString()
  resetWizard()
}

async function disableMfa() {
  dialogStore.openDialog({
    title: t('alert-2fa-disable'),
    description: `${t('alert-not-reverse-message')} ${t('alert-disable-2fa-message')}?`,
    buttons: [
      { text: t('button-cancel'), role: 'cancel' },
      { text: t('disable'), role: 'danger', id: 'confirm-button' },
    ],
  })
  const canceled = await dialogStore.onDialogDismiss()
  if (canceled)
    return

  const factorId = mfaFactorId.value
  if (!factorId) {
    toast.error(t('mfa-fail'))
    console.error('Factor id = null')
    return
  }

  const { error: unregisterError } = await supabase.auth.mfa.unenroll({ factorId })
  if (unregisterError) {
    toast.error(t('mfa-fail'))
    console.error('Cannot unregister MFA', unregisterError)
    return
  }

  mfaFactorId.value = ''
  mfaEnabled.value = false
  mfaSetupDate.value = null
  toast.success(t('2fa-disabled'))
}

function restartFromCaptcha() {
  captchaToken.value = ''
  savedCaptchaToken.value = ''
  captchaRef.value?.reset()
  otpVerificationCode.value = ''
  currentStep.value = 1
}

function resetWizard() {
  currentStep.value = 1
  captchaToken.value = ''
  savedCaptchaToken.value = ''
  captchaRef.value?.reset()
  otpVerificationCode.value = ''
  mfaQRCode.value = ''
  enrolledFactorId.value = ''
  mfaVerificationCode.value = ''
}

async function cleanupUnverifiedFactors(factors: { id: string, status: string }[]) {
  const unverified = factors.filter(f => f.status === 'unverified')
  if (unverified.length > 0) {
    await Promise.all(unverified.map(f => supabase.auth.mfa.unenroll({ factorId: f.id })))
  }
}

async function loadOtpVerificationStatus() {
  if (!main.auth?.id)
    return false
  const { data, error } = await supabase
    .from('user_security')
    .select('email_otp_verified_at')
    .eq('user_id', main.auth.id)
    .maybeSingle()

  if (error || !data?.email_otp_verified_at)
    return false

  const verifiedUntil = dayjs(data.email_otp_verified_at).add(1, 'hour')
  return dayjs().isBefore(verifiedUntil)
}

onMounted(async () => {
  const [{ data: mfaFactors, error }, otpValid] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    loadOtpVerificationStatus(),
  ])

  if (error) {
    console.error('Cannot get MFA factors', error)
    isLoading.value = false
    return
  }

  await cleanupUnverifiedFactors(mfaFactors.all)

  const verifiedFactor = mfaFactors.all.find(f => f.status === 'verified')
  mfaEnabled.value = !!verifiedFactor

  if (verifiedFactor) {
    mfaFactorId.value = verifiedFactor.id
    mfaSetupDate.value = verifiedFactor.created_at ?? verifiedFactor.updated_at ?? null
  }

  isLoading.value = false

  if (!mfaEnabled.value && otpValid) {
    otpAlreadyVerified.value = true
    await enrollTotp()
  }

  if (route.query.setup2fa === 'true' && !mfaEnabled.value) {
    await router.replace({ query: {} })
    await nextTick()
  }
})

onBeforeUnmount(async () => {
  if (enrolledFactorId.value && !mfaEnabled.value) {
    await supabase.auth.mfa.unenroll({ factorId: enrolledFactorId.value })
  }
})
</script>

<template>
  <div>
    <div class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-lg md:pb-0 max-h-fit grow md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
      <div class="p-6 space-y-6">
        <h2 class="mb-5 text-2xl font-bold dark:text-white text-slate-800">
          {{ t('manage-2fa') }}
        </h2>

        <!-- Loading -->
        <div v-if="isLoading" class="flex items-center justify-center py-12">
          <Spinner size="w-10 h-10" color="fill-blue-500 text-gray-200 dark:text-gray-600" />
        </div>

        <!-- 2FA Enabled View -->
        <div v-else-if="mfaEnabled" class="flex flex-col items-center py-8 space-y-6">
          <div class="flex items-center justify-center w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
            <svg class="w-10 h-10 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>

          <div class="text-center space-y-2">
            <h3 class="text-xl font-semibold dark:text-white text-slate-800">
              {{ t('2fa-is-enabled') }}
            </h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              {{ t('2fa-is-enabled-description') }}
            </p>
            <p v-if="setupDateLabel" class="text-sm text-slate-500 dark:text-slate-400">
              {{ t('2fa-setup-date', { date: setupDateLabel }) }}
            </p>
          </div>

          <button
            type="button"
            class="d-btn d-btn-outline d-btn-error d-btn-sm"
            @click="disableMfa"
          >
            {{ t('disable') }}
          </button>
        </div>

        <!-- 2FA Not Enabled View -->
        <div v-else class="space-y-8">
          <!-- Status icon + heading -->
          <div class="flex flex-col items-center space-y-3">
            <div class="flex items-center justify-center w-20 h-20 rounded-full bg-orange-100 dark:bg-orange-900/30">
              <svg class="w-10 h-10 text-orange-600 dark:text-orange-400" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <div class="text-center space-y-1">
              <h3 class="text-xl font-semibold dark:text-white text-slate-800">
                {{ t('2fa-is-not-enabled') }}
              </h3>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('2fa-is-not-enabled-description') }}
              </p>
            </div>
          </div>

          <!-- Stepper indicator -->
          <nav class="flex items-center justify-center">
            <ol class="flex items-center space-x-2 sm:space-x-4">
              <li v-for="step in totalSteps" :key="step" class="flex items-center">
                <div class="flex items-center">
                  <!-- Completed step -->
                  <div
                    v-if="step < currentStep"
                    class="flex items-center justify-center w-8 h-8 rounded-full bg-blue-500 text-white shrink-0"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke-width="3" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  </div>
                  <!-- Current step -->
                  <div
                    v-else-if="step === currentStep"
                    class="flex items-center justify-center w-8 h-8 rounded-full border-2 border-blue-500 text-blue-600 dark:text-blue-400 font-semibold text-sm shrink-0"
                  >
                    {{ step }}
                  </div>
                  <!-- Future step -->
                  <div
                    v-else
                    class="flex items-center justify-center w-8 h-8 rounded-full border-2 border-slate-300 dark:border-slate-600 text-slate-400 dark:text-slate-500 text-sm shrink-0"
                  >
                    {{ step }}
                  </div>

                  <span
                    class="ml-2 text-xs font-medium hidden sm:block"
                    :class="{
                      'text-blue-600 dark:text-blue-400': step === currentStep,
                      'text-slate-800 dark:text-white': step < currentStep,
                      'text-slate-400 dark:text-slate-500': step > currentStep,
                    }"
                  >
                    {{ stepLabels[step - 1] }}
                  </span>
                </div>
                <!-- Connector line -->
                <div
                  v-if="step < totalSteps"
                  class="w-6 sm:w-10 h-0.5 mx-1"
                  :class="step < currentStep ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'"
                />
              </li>
            </ol>
          </nav>

          <!-- Step content -->
          <div class="max-w-lg mx-auto">
            <!-- Step 1: CAPTCHA -->
            <div v-if="currentStep === 1" class="space-y-4">
              <h4 class="text-lg font-medium dark:text-white text-slate-800">
                {{ t('2fa-step-captcha') }}
              </h4>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('captcha') }}
              </p>
              <div v-if="captchaKey">
                <VueTurnstile
                  ref="captchaRef"
                  v-model="captchaToken"
                  size="flexible"
                  :site-key="captchaKey"
                />
              </div>
              <div v-else>
                <!-- No captcha configured, skip step -->
                <button
                  type="button"
                  class="d-btn d-btn-primary d-btn-sm"
                  @click="currentStep = 2"
                >
                  {{ t('next') }}
                </button>
              </div>
            </div>

            <!-- Step 2: Send verification code -->
            <div v-if="currentStep === 2" class="space-y-4">
              <h4 class="text-lg font-medium dark:text-white text-slate-800">
                {{ t('2fa-step-send-code') }}
              </h4>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('email-otp-2fa-description') }}
              </p>
              <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-700/50">
                <p class="text-sm font-medium dark:text-white text-slate-800">
                  {{ otpEmail }}
                </p>
              </div>
              <button
                type="button"
                class="d-btn d-btn-primary d-btn-sm"
                :class="{ 'opacity-50 cursor-not-allowed': otpSending }"
                :disabled="otpSending"
                @click="sendOtpVerification"
              >
                <Spinner v-if="otpSending" size="w-4 h-4" class="mr-2" color="fill-white text-blue-300" />
                {{ t('email-otp-send-code') }}
              </button>
            </div>

            <!-- Step 3: Enter verification code -->
            <div v-if="currentStep === 3" class="space-y-4">
              <h4 class="text-lg font-medium dark:text-white text-slate-800">
                {{ t('2fa-step-enter-code') }}
              </h4>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('email-otp-sent') }}
              </p>
              <label for="mfa-otp-verification-code" class="sr-only">{{ t('verification-code') }}</label>
              <input
                id="mfa-otp-verification-code"
                v-model="otpVerificationCode"
                type="text"
                inputmode="numeric"
                :placeholder="t('verification-code')"
                :aria-label="t('verification-code')"
                class="d-input w-full"
                autocomplete="one-time-code"
                @keydown.enter.prevent="verifyOtpForMfa"
              >
              <div class="flex gap-2">
                <button
                  type="button"
                  class="d-btn d-btn-primary d-btn-sm"
                  :class="{ 'opacity-50 cursor-not-allowed': otpVerificationLoading || !otpVerificationCode }"
                  :disabled="otpVerificationLoading || !otpVerificationCode"
                  @click="verifyOtpForMfa"
                >
                  <Spinner v-if="otpVerificationLoading" size="w-4 h-4" class="mr-2" color="fill-white text-blue-300" />
                  {{ t('verify') }}
                </button>
                <button
                  type="button"
                  class="d-btn d-btn-outline d-btn-sm"
                  @click="restartFromCaptcha"
                >
                  {{ t('resend') }}
                </button>
              </div>
            </div>

            <!-- Step 4: Scan QR code -->
            <div v-if="currentStep === 4" class="space-y-4">
              <h4 class="text-lg font-medium dark:text-white text-slate-800">
                {{ t('2fa-step-scan-qr') }}
              </h4>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('mfa-enable-instruction') }}
              </p>
              <div v-if="mfaQRCode" class="flex justify-center p-4 rounded-lg bg-white dark:bg-slate-700/50">
                <img
                  :src="mfaQRCode"
                  alt="QR Code for 2FA setup"
                  class="w-48 h-48"
                >
              </div>
              <button
                type="button"
                class="d-btn d-btn-primary d-btn-sm"
                @click="proceedToVerify"
              >
                {{ t('next') }}
              </button>
            </div>

            <!-- Step 5: Enter 2FA code -->
            <div v-if="currentStep === 5" class="space-y-4">
              <h4 class="text-lg font-medium dark:text-white text-slate-800">
                {{ t('2fa-step-verify-totp') }}
              </h4>
              <p class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('mfa-enable-instruction-2') }}
              </p>
              <label for="mfa-totp-verification-code" class="sr-only">{{ t('verification-code') }}</label>
              <input
                id="mfa-totp-verification-code"
                v-model="mfaVerificationCode"
                type="text"
                inputmode="numeric"
                :placeholder="t('verification-code')"
                :aria-label="t('verification-code')"
                class="d-input w-full"
                maxlength="6"
                autocomplete="one-time-code"
                @keydown.enter.prevent="verifyAndEnable"
              >
              <button
                type="button"
                class="d-btn d-btn-primary d-btn-sm"
                :class="{ 'opacity-50 cursor-not-allowed': mfaVerifying || !mfaVerificationCode }"
                :disabled="mfaVerifying || !mfaVerificationCode"
                @click="verifyAndEnable"
              >
                <Spinner v-if="mfaVerifying" size="w-4 h-4" class="mr-2" color="fill-white text-blue-300" />
                {{ t('2fa-verify-and-enable') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
path: /settings/account/manage-2fa
meta:
  layout: settings
</route>
