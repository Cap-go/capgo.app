<script setup lang="ts">
import type { Factor } from '@supabase/supabase-js'
import type { Ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { setErrors } from '@formkit/core'
import { FormKit, FormKitMessages } from '@formkit/vue'
import dayjs from 'dayjs'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import IconBack from '~icons/material-symbols/arrow-back-ios-rounded'
import iconEmail from '~icons/oui/email?raw'
import iconPassword from '~icons/ph/key?raw'
import mfaIcon from '~icons/simple-icons/2fas?raw'
import { hideLoader } from '~/services/loader'
import { autoAuth, defaultApiHost, hashEmail, useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'

const route = useRoute('/login')
const supabase = useSupabase()
const isLoading = ref(false)
const isMobile = ref(Capacitor.isNativePlatform())
const turnstileToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const statusAuth: Ref<'email' | 'credentials' | '2fa'> = ref('email')
const mfaLoginFactor: Ref<Factor | null> = ref(null)
const mfaChallengeId: Ref<string> = ref('')
const querySessionAccessToken = ref('')
const querySessionRefreshToken = ref('')
const hasQuerySession = ref(false)
const router = useRouter()
const { t } = useI18n()
const captchaComponent = ref<InstanceType<typeof VueTurnstile> | null>(null)

// Two-step login state
const emailForLogin = ref('')
const hasSso = ref(false)
const enforceSso = ref(false)
const isDomainChecking = ref(false)
const isCheckingSavedSession = ref(true)
const captchaStatus = ref<'disabled' | 'loading' | 'ready' | 'unavailable'>(captchaKey.value ? 'loading' : 'disabled')
let captchaInitTimeout: ReturnType<typeof setTimeout> | null = null

const version = import.meta.env.VITE_APP_VERSION
const isEmailStepBusy = computed(() => isDomainChecking.value || isCheckingSavedSession.value)
const shouldBlockForCaptcha = computed(() => !!captchaKey.value && captchaStatus.value === 'loading' && !turnstileToken.value)
const loginHeroChips = computed(() => [
  t('login-chip-live-updates'),
  t('login-chip-release-analytics'),
  t('login-chip-channel-control'),
])
const loginHeroHighlights = computed(() => [
  {
    title: t('login-highlight-rollouts-title'),
    description: t('login-highlight-rollouts-description'),
  },
  {
    title: t('login-highlight-observability-title'),
    description: t('login-highlight-observability-description'),
  },
  {
    title: t('login-highlight-team-title'),
    description: t('login-highlight-team-description'),
  },
])
const authCardShellClass = [
  'rounded-none border-0 bg-transparent p-0 shadow-none backdrop-blur-0',
  'sm:rounded-[1.75rem] sm:border sm:border-slate-200/75 sm:bg-[linear-gradient(180deg,rgba(255,255,255,0.94)_0%,rgba(255,255,255,0.84)_100%)]',
  'sm:p-7 sm:shadow-[0_34px_80px_-42px_rgba(15,23,42,0.5)] sm:backdrop-blur-[18px]',
  'sm:dark:border-slate-600/70 sm:dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.88)_0%,rgba(15,23,42,0.7)_100%)]',
].join(' ')
const authCardHeaderClass = 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'
const authStepCardClass = 'min-w-0'
const authCardBodyClass = 'py-1'
const authPanelClass = 'flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-slate-200/70 pt-4 text-center text-sm dark:border-slate-700/80'
const authPrimaryButtonClass = [
  'inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4 text-base font-semibold text-white',
  'bg-[linear-gradient(135deg,rgba(36,67,102,1)_0%,rgba(12,110,184,1)_100%)] shadow-[0_20px_38px_-26px_rgba(17,158,255,0.85)]',
  'transition duration-200 hover:-translate-y-0.5 hover:brightness-105',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-azure-500)]',
  'disabled:pointer-events-none disabled:opacity-60',
].join(' ')
const authSecondaryButtonClass = [
  'inline-flex w-full items-center justify-center rounded-xl border border-slate-400/55 bg-white/92 px-4 py-4 text-base font-semibold text-slate-700',
  'transition duration-200 hover:border-[rgba(17,158,255,0.45)] hover:bg-slate-100/95',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-azure-500)]',
  'dark:border-slate-600/90 dark:bg-slate-950/85 dark:text-slate-200 dark:hover:bg-slate-800/95',
  'disabled:pointer-events-none disabled:opacity-60',
].join(' ')
const authAccountContextClass = [
  'flex min-w-0 flex-col items-start gap-2 rounded-2xl border border-slate-200/80 bg-slate-50/80 p-2',
  'dark:border-slate-700 dark:bg-slate-900/70',
].join(' ')
const authBackToEmailButtonClass = [
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-slate-700',
  'transition duration-200 hover:bg-white hover:text-slate-950',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-azure-500)]',
  'dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white',
  'disabled:pointer-events-none disabled:opacity-60',
].join(' ')
const authSelectedEmailClass = [
  'w-full min-w-0 rounded-xl bg-white/75 px-3 py-2 text-sm font-medium leading-5 text-slate-700 [overflow-wrap:anywhere]',
  'dark:bg-slate-950/55 dark:text-slate-100',
].join(' ')
const authInlineLinkClass = [
  'inline-flex min-h-6 items-center justify-center gap-1 border-none bg-transparent p-0 text-[0.95rem] font-semibold text-[rgb(255,114,17)]',
  'transition-colors duration-200 hover:text-[rgb(235,94,0)]',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-azure-500)]',
].join(' ')
const authGhostButtonClass = [
  'rounded-full px-4 py-[0.55rem] text-[0.95rem] font-medium text-slate-500 transition-colors duration-200',
  'hover:bg-slate-200/75 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800/85 dark:hover:text-white',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-azure-500)]',
].join(' ')

const registerUrl = globalThis.location.host === 'console.capgo.app' ? 'https://capgo.app/register/' : `/register/`

function focusLoginEmailInput(attempt = 0) {
  globalThis.setTimeout(() => {
    const emailInput = document.querySelector<HTMLInputElement>('input#login-email, #login-email input, input[data-test="email"]')
    if (!emailInput || emailInput.disabled) {
      if (attempt < 8)
        focusLoginEmailInput(attempt + 1)
      return
    }

    emailInput.focus()
    emailInput.select()

    if (document.activeElement !== emailInput && attempt < 8)
      focusLoginEmailInput(attempt + 1)
  }, attempt === 0 ? 240 : 100)
}

function clearCaptchaInitTimeout() {
  if (captchaInitTimeout) {
    clearTimeout(captchaInitTimeout)
    captchaInitTimeout = null
  }
}

function scheduleCaptchaInitTimeout() {
  if (!captchaKey.value || statusAuth.value !== 'credentials') {
    clearCaptchaInitTimeout()
    return
  }

  clearCaptchaInitTimeout()
  captchaInitTimeout = setTimeout(() => {
    if (!turnstileToken.value && !(globalThis as typeof globalThis & { turnstile?: unknown }).turnstile) {
      captchaStatus.value = 'unavailable'
      console.error('Turnstile failed to initialize')
    }
  }, 8000)
}

function handleCaptchaUnavailable(reason: string, error?: unknown) {
  captchaStatus.value = 'unavailable'
  clearCaptchaInitTimeout()
  console.error(reason, error)
}

watch(turnstileToken, (token) => {
  if (!captchaKey.value) {
    captchaStatus.value = 'disabled'
    return
  }

  if (token) {
    captchaStatus.value = 'ready'
    clearCaptchaInitTimeout()
  }
  else if (statusAuth.value === 'credentials') {
    captchaStatus.value = 'loading'
    scheduleCaptchaInitTimeout()
  }
})

watch(statusAuth, (status) => {
  if (!captchaKey.value) {
    captchaStatus.value = 'disabled'
    clearCaptchaInitTimeout()
    return
  }

  if (status === 'credentials') {
    captchaStatus.value = turnstileToken.value ? 'ready' : 'loading'
    scheduleCaptchaInitTimeout()
  }
  else {
    clearCaptchaInitTimeout()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  clearCaptchaInitTimeout()
})

async function nextLogin() {
  if (route.query.to && typeof route.query.to === 'string') {
    await router.replace(route.query.to)
  }
  else {
    await router.replace('/dashboard')
  }
  setTimeout(async () => {
    isLoading.value = false
  }, 500)
}

async function checkMfa() {
  const { data: mfaFactors, error: mfaError } = await supabase.auth.mfa.listFactors()
  if (mfaError) {
    setErrors('login-account', ['See browser console'], {})
    console.error('Cannot get MFA factors', mfaError)
    return
  }

  const unverified = mfaFactors.all.filter(factor => factor.status === 'unverified')
  if (unverified && unverified.length > 0) {
    console.log(`Found ${unverified.length} unverified MFA factors, removing all`)
    const responses = await Promise.all(unverified.map(factor => supabase.auth.mfa.unenroll({ factorId: factor.id })))

    responses.filter(res => !!res.error).forEach((res) => {
      console.error('Failed to unregister', res.error)
    })
  }

  const mfaFactor = mfaFactors?.all.find(factor => factor.status === 'verified')
  const hasMfa = !!mfaFactor

  if (hasMfa) {
    mfaLoginFactor.value = mfaFactor
    const { data: challenge, error: errorChallenge } = await supabase.auth.mfa.challenge({ factorId: mfaFactor.id })
    if (errorChallenge) {
      isLoading.value = false
      setErrors('login-account', ['See browser console'], {})
      console.error('Cannot challenge mfa', errorChallenge)
      return
    }

    mfaChallengeId.value = challenge.id
    statusAuth.value = '2fa'
    isLoading.value = false
  }
  else {
    await nextLogin()
  }
}

async function checkReviewAccount(form: { email: string }) {
  // this is a review account, we need to check if the user is banned for Apple and Google to check delete feature
  const { data: userPreData, error: userPreError } = await supabase.from('users').select('ban_time').eq('email', form.email).single()
  if (!userPreData && userPreError) {
    isLoading.value = false
    console.error('error', userPreError)
    setErrors('login-account', [userPreError.message], {})
    toast.error(t('failed-to-get-user'))
    return
  }

  if (!!userPreData.ban_time && dayjs().isBefore(userPreData.ban_time)) {
    isLoading.value = false
    setErrors('login-account', ['Invalid login credentials'], {})
    toast.error(t('failed-to-get-user'))
  }
}

async function login(form: { email: string, password: string }) {
  const hashedEmail = await hashEmail(form.email)
  const { data: deleted, error: errorDeleted } = await supabase
    .rpc('is_not_deleted', { email_check: hashedEmail })
  if (errorDeleted) {
    console.error(errorDeleted)
    isLoading.value = false
    setErrors('login-account', [errorDeleted.message], {})
    return
  }

  if (!deleted) {
    toast.error(t('used-to-create'))
    isLoading.value = false
    setErrors('login-account', [t('used-to-create')], {})
    return
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: form.email,
    password: form.password,
    options: {
      captchaToken: turnstileToken.value,
    },
  })
  if (error) {
    isLoading.value = false
    const isExpectedAuthError = error.code === 'invalid_credentials'
      || error.code === 'captcha_failed'
    if (!isExpectedAuthError)
      console.error('Login failed', error)
    setErrors('login-account', [error.message], {})
    if (error.code === 'invalid_credentials' || error.message.includes('Invalid login credentials')) {
      turnstileToken.value = ''
      captchaComponent.value?.reset()
    }
    if (error.code === 'captcha_failed' || error.message.includes('captcha')) {
      turnstileToken.value = ''
      captchaComponent.value?.reset()
      toast.error(t('captcha-fail'))
    }
    else {
      toast.error(t('invalid-auth'))
    }

    return
  }

  if (form.email.endsWith('review@capgo.app') && Capacitor.isNativePlatform()) {
    await checkReviewAccount(form)
  }

  await checkMfa()
}

async function checkDomain(email: string): Promise<{ has_sso: boolean, enforce_sso?: boolean, provider_id?: string, org_id?: string }> {
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(`${defaultApiHost}/private/sso/check-domain`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
    })

    if (!response.ok) {
      return { has_sso: false }
    }

    return await response.json()
  }
  catch {
    return { has_sso: false }
  }
}

async function handleEmailContinue(form: { email: string }) {
  isDomainChecking.value = true
  emailForLogin.value = form.email

  const result = await checkDomain(form.email)
  hasSso.value = result.has_sso
  enforceSso.value = result.enforce_sso === true

  isDomainChecking.value = false
  statusAuth.value = 'credentials'
}

async function handlePasswordSubmit(form: { password: string }) {
  isLoading.value = true
  await login({ email: emailForLogin.value, password: form.password })
}

async function handleSsoLogin() {
  if (isLoading.value || shouldBlockForCaptcha.value) {
    return
  }

  isLoading.value = true
  const domain = emailForLogin.value.split('@')[1]

  try {
    const redirectUrl = new URL('/sso-callback', globalThis.location.origin)
    if (route.query.to && typeof route.query.to === 'string') {
      redirectUrl.searchParams.set('to', route.query.to)
    }

    const { data, error } = await supabase.auth.signInWithSSO({
      domain,
      options: {
        redirectTo: redirectUrl.toString(),
        captchaToken: turnstileToken.value,
      },
    })

    if (error) {
      console.error('SSO login error', error)
      turnstileToken.value = ''
      captchaComponent.value?.reset()
      if (error.message.includes('captcha')) {
        toast.error(t('captcha-fail'))
      }
      else {
        toast.error(t('invalid-auth'))
      }
      isLoading.value = false
      return
    }

    if (data?.url) {
      globalThis.location.href = data.url
    }
  }
  catch (err) {
    console.error('SSO login error', err)
    turnstileToken.value = ''
    captchaComponent.value?.reset()
    toast.error(t('invalid-auth'))
    isLoading.value = false
  }
}

async function handleMfaSubmit(form: { code: string }) {
  isLoading.value = true
  const verify = await supabase.auth.mfa.verify({
    factorId: mfaLoginFactor.value!.id!,
    challengeId: mfaChallengeId.value!,
    code: form.code.replaceAll(' ', ''),
  })

  if (verify.error) {
    toast.error(t('invalid-mfa-code'))
    console.error('verify error', verify.error)
    isLoading.value = false
  }
  else {
    await nextLogin()
    isLoading.value = false
  }
}

async function goBackToEmail() {
  if (isLoading.value) {
    return
  }

  statusAuth.value = 'email'
  hasSso.value = false
  enforceSso.value = false

  await nextTick()
  focusLoginEmailInput()
}

async function goToForgotPassword() {
  await router.push({
    path: '/forgot_password',
    state: emailForLogin.value ? { resetEmail: emailForLogin.value } : undefined,
  })
}

async function checkAuthUser() {
  const { data: mfaData, error: mfaError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (mfaError) {
    console.error('Cannot guard auth', mfaError)
    isLoading.value = false
    return
  }

  if (mfaData.currentLevel === 'aal1' && mfaData.nextLevel === 'aal2') {
    const { data: mfaFactors, error } = await supabase.auth.mfa.listFactors()
    if (error) {
      setErrors('login-account', ['See browser console'], {})
      console.error('Cannot get MFA factors', error)
      isLoading.value = false
      return
    }

    const mfaFactor = mfaFactors?.all.find(factor => factor.status === 'verified')

    const { data: challenge, error: errorChallenge } = await supabase.auth.mfa.challenge({ factorId: mfaFactor!.id })
    if (errorChallenge) {
      setErrors('login-account', ['See browser console'], {})
      console.error('Cannot challenge mfa', errorChallenge)
      isLoading.value = false
      return
    }

    mfaLoginFactor.value = mfaFactor!
    mfaChallengeId.value = challenge.id

    statusAuth.value = '2fa'
    isLoading.value = false
  }
  else {
    await nextLogin()
  }
}

async function checkMagicLink() {
  const parsedUrl = new URL(route.fullPath, globalThis.location.origin)

  const hash = parsedUrl.hash
  const params = new URLSearchParams(hash.slice(1))
  const error = params.get('error_description')
  const message = params.get('message')
  const authType = params.get('type')

  if (message) {
    isLoading.value = false
    hideLoader()
    return setTimeout(() => {
      toast.success(message, {
        duration: 7000,
      })
    }, 400)
  }
  if (error) {
    isLoading.value = false
    hideLoader()
    return toast.error(error)
  }

  const logSession = await autoAuth(route)
  if (!logSession) {
    isLoading.value = false
    hideLoader()
    return
  }
  if (logSession.user && logSession?.user?.email && logSession?.user?.id) {
    if (authType === 'email_change') {
      const email = logSession.user.email
      const id = logSession.user.id
      await supabase
        .from('users')
        .upsert({
          id,
          email,
        }, { onConflict: 'id' })
        .select()
        .single()
    }
    await nextLogin()
  }
}

async function openScan() {
  router.push('/scan')
}

async function checkLogin() {
  try {
    const parsedUrl = new URL(route.fullPath, globalThis.location.origin)
    const params = new URLSearchParams(parsedUrl.search)

    if (params.get('message') === 'sso_account_linked') {
      parsedUrl.searchParams.delete('message')
      globalThis.history.replaceState({}, '', parsedUrl.toString())
      toast.success(t('sso-account-linked'))
    }

    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')

    if (!!accessToken && !!refreshToken) {
      parsedUrl.searchParams.delete('access_token')
      parsedUrl.searchParams.delete('refresh_token')
      globalThis.history.replaceState({}, '', parsedUrl.toString())

      querySessionAccessToken.value = accessToken
      querySessionRefreshToken.value = refreshToken
      hasQuerySession.value = true
      isLoading.value = false
      hideLoader()
      return
    }

    isLoading.value = true
    const { data: claimsData } = await supabase.auth.getClaims()
    const hasUser = !!claimsData?.claims?.sub
    const { data: sessionData } = await supabase.auth.getSession()
    const session = sessionData?.session
    if (hasUser) {
      await checkAuthUser()
    }
    else if (!session && route.query.code && typeof route.query.code === 'string') {
      const { data, error } = await supabase.auth.exchangeCodeForSession(route.query.code)
      if (!error && data.session) {
        await nextLogin()
      }
      else {
        isLoading.value = false
        hideLoader()
      }
    }
    else if (!session && route.hash) {
      await checkMagicLink()
    }
    else {
      isLoading.value = false
      hideLoader()
    }
  }
  catch (error) {
    console.error('Login bootstrap failed', error)
    isLoading.value = false
    hideLoader()
  }
  finally {
    isCheckingSavedSession.value = false
  }
}

async function acceptQuerySession() {
  isLoading.value = true
  const res = await supabase.auth.setSession({
    access_token: querySessionAccessToken.value,
    refresh_token: querySessionRefreshToken.value,
  })
  if (res.error) {
    if (res.error.name === 'AuthSessionMissingError')
      console.warn('Cannot set auth', res.error)
    else
      console.error('Cannot set auth', res.error)
    isLoading.value = false
    return
  }

  hasQuerySession.value = false
  querySessionAccessToken.value = ''
  querySessionRefreshToken.value = ''
  nextLogin()
}

function declineQuerySession() {
  hasQuerySession.value = false
  querySessionAccessToken.value = ''
  querySessionRefreshToken.value = ''
  isLoading.value = false
  hideLoader()
}

// eslint-disable-next-line regexp/no-unused-capturing-group
const mfaRegex = /(((\d){6})|((\d){3} (\d){3}))$/
function mfa_code_validation(node: { value: any }) {
  return Promise.resolve(mfaRegex.test(node.value))
}

async function goback() {
  const { error } = await supabase.auth.signOut()

  if (error) {
    toast.error(t('cannot-sign-off'))
    console.error('cannot log off', error)
    return
  }

  mfaChallengeId.value = ''
  mfaLoginFactor.value = null
  statusAuth.value = 'email'
}
onMounted(checkLogin)
</script>

<template>
  <section
    class="relative flex h-dvh min-h-dvh w-full overflow-y-auto bg-[linear-gradient(180deg,rgba(248,250,252,0.98)_0%,rgba(238,244,255,0.9)_55%,rgba(248,250,252,0.98)_100%)] dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.98)_0%,rgba(20,29,53,0.96)_52%,rgba(15,23,42,0.98)_100%)]"
  >
    <div class="pointer-events-none absolute inset-0 hidden overflow-hidden lg:block" aria-hidden="true">
      <div class="absolute top-[10%] -left-32 h-[22rem] w-[22rem] rounded-full bg-[rgba(17,158,255,0.22)] opacity-55 blur-[52px]" />
      <div class="absolute right-[-7rem] bottom-[8%] h-[18rem] w-[18rem] rounded-full bg-[rgba(104,118,225,0.18)] opacity-55 blur-[52px]" />
      <div
        class="absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:3rem_3rem] [mask-image:radial-gradient(circle_at_center,black_40%,transparent_82%)]"
      />
    </div>

    <div class="relative mx-auto grid w-full max-w-7xl gap-6 px-4 py-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8 lg:min-h-dvh lg:grid-cols-[minmax(0,1.08fr)_minmax(24rem,30rem)] lg:items-center lg:gap-8 lg:px-8 lg:py-10">
      <section class="hidden lg:block">
        <div class="max-w-2xl">
          <div class="inline-flex flex-wrap gap-2">
            <span
              v-for="chip in loginHeroChips"
              :key="chip"
              class="rounded-full border border-white/60 bg-white/70 px-3 py-1 text-xs font-medium tracking-[0.18em] text-slate-600 uppercase shadow-sm backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/60 dark:text-slate-200"
            >
              {{ chip }}
            </span>
          </div>

          <div class="mt-8 space-y-5">
            <div class="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200/70 bg-white/80 shadow-lg shadow-slate-900/5 backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/70">
              <img src="/capgo.webp" alt="Capgo logo" class="h-8 w-8 rounded-sm invert dark:invert-0">
            </div>
            <div>
              <p class="text-xs font-semibold tracking-[0.26em] text-slate-500 uppercase dark:text-slate-300">
                {{ t('login-console-kicker') }}
              </p>
              <h1 class="mt-4 text-4xl font-semibold leading-tight text-slate-950 dark:text-white xl:text-5xl">
                {{ t('login-console-title') }}
              </h1>
              <p class="mt-5 max-w-xl text-base leading-7 text-slate-600 dark:text-slate-300 xl:text-lg">
                {{ t('login-console-description') }}
              </p>
            </div>
          </div>

          <div class="mt-10 grid gap-4 sm:grid-cols-3">
            <article
              v-for="highlight in loginHeroHighlights"
              :key="highlight.title"
              class="rounded-3xl border border-white/70 bg-white/78 p-5 shadow-[0_20px_50px_-30px_rgba(15,23,42,0.45)] backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/72"
            >
              <div class="mb-3 h-2 w-12 rounded-full bg-gradient-to-r from-sky-500 via-sky-400 to-indigo-500" />
              <h2 class="text-base font-semibold text-slate-900 dark:text-white">
                {{ highlight.title }}
              </h2>
              <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ highlight.description }}
              </p>
            </article>
          </div>
        </div>
      </section>

      <div class="relative mx-auto flex w-full max-w-[calc(100vw-2rem)] flex-col sm:max-w-lg lg:block lg:max-w-none">
        <div class="mb-5 flex items-center gap-3 lg:hidden">
          <span class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200/80 bg-white/80 shadow-sm dark:border-slate-700 dark:bg-slate-900/70">
            <img src="/capgo.webp" alt="Capgo logo" class="h-7 w-7 rounded-sm invert dark:invert-0">
          </span>
          <div class="min-w-0">
            <p class="text-[0.7rem] font-semibold tracking-[0.18em] text-slate-500 uppercase dark:text-slate-300">
              {{ t('login-console-kicker') }}
            </p>
            <p class="mt-1 truncate text-sm font-medium text-slate-600 dark:text-slate-300">
              <span class="font-prompt">Capgo</span>
            </p>
          </div>
        </div>

        <div :class="authCardShellClass">
          <div :class="authCardHeaderClass">
            <div>
              <p class="text-[0.72rem] font-bold tracking-[0.22em] text-slate-500 uppercase dark:text-slate-400">
                {{ t('login-auth-kicker') }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold leading-tight text-slate-950 dark:text-white sm:mt-3">
                {{ t('login-to-your-account') }}
              </h2>
              <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-300">
                {{ t('login-auth-description') }}
              </p>
            </div>
            <span class="self-start shrink-0 rounded-full border border-slate-300/90 bg-white/90 px-3 py-1.5 text-[0.72rem] font-semibold text-slate-600 dark:border-slate-600/90 dark:bg-slate-800/90 dark:text-slate-200 sm:bg-slate-50/95 sm:px-3.5 sm:py-2 sm:text-[0.78rem]">
              {{ version }}
            </span>
          </div>

          <div class="relative mt-5 sm:mt-6">
            <div v-if="hasQuerySession" :class="authStepCardClass">
              <div class="space-y-4 text-slate-500 dark:text-slate-300" :class="authCardBodyClass">
                <p class="text-sm">
                  {{ t('login-query-session-prompt') }}
                </p>
                <button
                  type="button" data-test="accept-query-session" :disabled="isLoading" :aria-busy="isLoading ? 'true' : 'false'"
                  :class="authPrimaryButtonClass"
                  @click="acceptQuerySession"
                >
                  <svg
                    v-if="isLoading" class="inline-block mr-3 -ml-1 w-5 h-5 text-white align-middle animate-spin"
                    xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" data-test="loading"
                  >
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path
                      class="opacity-75" fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  {{ t('continue') }}
                </button>
                <button
                  type="button" :disabled="isLoading"
                  :class="authSecondaryButtonClass"
                  @click="declineQuerySession"
                >
                  {{ t('cancel') }}
                </button>
              </div>
            </div>

            <Transition
              v-else
              mode="out-in"
              enter-active-class="transition duration-200 ease-out"
              enter-from-class="translate-x-6 opacity-0"
              enter-to-class="translate-x-0 opacity-100"
              leave-active-class="transition duration-200 ease-in"
              leave-from-class="translate-x-0 opacity-100"
              leave-to-class="-translate-x-6 opacity-0"
            >
              <!-- Step 1: Email -->
              <div v-if="statusAuth === 'email'" key="step-email" :class="authStepCardClass">
                <div class="text-slate-500 dark:text-slate-300" :class="authCardBodyClass">
                  <FormKit id="email-step" type="form" :actions="false" @submit="handleEmailContinue">
                    <div class="space-y-5">
                      <FormKit
                        id="login-email" type="email" name="email" :disabled="isEmailStepBusy" enterkeyhint="next" :placeholder="t('email')"
                        :prefix-icon="iconEmail" inputmode="email" :label="t('email')" autocomplete="email"
                        validation="required:trim" data-test="email"
                      />
                      <FormKitMessages data-test="form-error" />
                      <div>
                        <div class="inline-flex justify-center items-center w-full">
                          <button
                            type="submit" data-test="continue" :disabled="isEmailStepBusy" :aria-busy="isEmailStepBusy ? 'true' : 'false'"
                            :class="authPrimaryButtonClass"
                          >
                            <svg
                              v-if="isEmailStepBusy" class="inline-block mr-3 -ml-1 w-5 h-5 text-white align-middle animate-spin"
                              xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" data-test="loading"
                            >
                              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                              <path
                                class="opacity-75" fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            {{ t('continue') }}
                          </button>
                        </div>
                      </div>

                      <div :class="authPanelClass">
                        <span class="text-slate-500 dark:text-slate-400">
                          {{ t('dont-have-an-account') }}
                        </span>
                        <a
                          v-if="!isMobile"
                          :href="registerUrl"
                          data-test="register"
                          :class="authInlineLinkClass"
                        >
                          {{ t('create-a-free-account') }}
                        </a>
                      </div>
                    </div>
                  </FormKit>
                </div>
              </div>

              <!-- Step 2: Credentials (SSO or Password) -->
              <div v-else-if="statusAuth === 'credentials'" key="step-credentials" :class="authStepCardClass">
                <div class="text-slate-500 dark:text-slate-300" :class="authCardBodyClass">
                  <!-- SSO path (enforce_sso=true: SSO only) -->
                  <div v-if="hasSso && enforceSso" class="space-y-5">
                    <!-- Show email context -->
                    <div :class="authAccountContextClass">
                      <button
                        type="button"
                        data-test="back-to-email"
                        :disabled="isLoading"
                        :aria-label="t('go-back')"
                        :class="authBackToEmailButtonClass"
                        @click="goBackToEmail"
                      >
                        <IconBack class="h-4 w-4 fill-current" aria-hidden="true" />
                        <span>{{ t('go-back') }}</span>
                      </button>
                      <p data-test="selected-email" :class="authSelectedEmailClass">
                        {{ emailForLogin }}
                      </p>
                    </div>
                    <p class="text-sm text-slate-600 dark:text-slate-300">
                      {{ t('sso-detected') }}
                    </p>
                    <div v-if="!!captchaKey">
                      <VueTurnstile
                        ref="captchaComponent"
                        v-model="turnstileToken"
                        size="flexible"
                        :site-key="captchaKey"
                        @error="handleCaptchaUnavailable('Turnstile error', $event)"
                        @unsupported="handleCaptchaUnavailable('Turnstile unsupported')"
                      />
                    </div>
                    <div>
                      <div class="inline-flex justify-center items-center w-full">
                        <button
                          type="button" data-test="sso-login" :disabled="isLoading || shouldBlockForCaptcha" :aria-busy="isLoading ? 'true' : 'false'"
                          :class="authPrimaryButtonClass"
                          @click="handleSsoLogin"
                        >
                          <svg
                            v-if="isLoading" class="inline-block mr-3 -ml-1 w-5 h-5 text-white align-middle animate-spin"
                            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" data-test="loading"
                          >
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path
                              class="opacity-75" fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          {{ t('continue-with-sso') }}
                        </button>
                      </div>
                    </div>
                  </div>

                  <!-- Password path (with optional SSO button when enforce_sso=false) -->
                  <div v-else>
                    <FormKit id="login-account" type="form" :actions="false" @submit="handlePasswordSubmit">
                      <div class="space-y-5">
                        <!--
                      Hidden email input placed inside the form so browsers and password managers
                      can associate the password field with the correct account (autocomplete="username").
                      Uses opacity+absolute positioning instead of display:none so browsers still
                      detect it for autofill purposes.
                    -->
                        <input
                          id="login-username-hidden"
                          type="email"
                          :value="emailForLogin"
                          name="username"
                          autocomplete="username"
                          readonly
                          tabindex="-1"
                          aria-hidden="true"
                          :aria-label="t('email')"
                          style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;"
                        >
                        <div :class="authAccountContextClass">
                          <button
                            type="button"
                            data-test="back-to-email"
                            :disabled="isLoading"
                            :aria-label="t('go-back')"
                            :class="authBackToEmailButtonClass"
                            @click="goBackToEmail"
                          >
                            <IconBack class="h-4 w-4 fill-current" aria-hidden="true" />
                            <span>{{ t('go-back') }}</span>
                          </button>
                          <p data-test="selected-email" :class="authSelectedEmailClass">
                            {{ emailForLogin }}
                          </p>
                        </div>
                        <!-- Optional SSO button when SSO exists but is not enforced -->
                        <div v-if="hasSso && !enforceSso">
                          <button
                            type="button" data-test="sso-login"
                            :disabled="isLoading || shouldBlockForCaptcha"
                            :aria-busy="isLoading ? 'true' : 'false'"
                            :class="authPrimaryButtonClass"
                            @click="handleSsoLogin"
                          >
                            {{ t('continue-with-sso') }}
                          </button>
                          <div class="flex items-center my-4">
                            <div class="flex-1 h-px bg-gray-200 dark:bg-gray-600" />
                            <span class="px-3 text-sm text-gray-400">{{ t('login-or-separator') }}</span>
                            <div class="flex-1 h-px bg-gray-200 dark:bg-gray-600" />
                          </div>
                        </div>
                        <div>
                          <FormKit
                            id="passwordInput" type="password" :placeholder="t('password')"
                            name="password" :label="t('password')" :prefix-icon="iconPassword" :disabled="isLoading"
                            validation="required:trim" enterkeyhint="send" autocomplete="current-password"
                            data-test="password"
                          />
                        </div>
                        <div v-if="!!captchaKey">
                          <VueTurnstile
                            ref="captchaComponent"
                            v-model="turnstileToken"
                            size="flexible"
                            :site-key="captchaKey"
                            @error="handleCaptchaUnavailable('Turnstile error', $event)"
                            @unsupported="handleCaptchaUnavailable('Turnstile unsupported')"
                          />
                        </div>
                        <FormKitMessages data-test="form-error" />
                        <div>
                          <div class="inline-flex justify-center items-center w-full">
                            <button
                              type="submit" data-test="submit" :disabled="isLoading || shouldBlockForCaptcha" :aria-busy="isLoading ? 'true' : 'false'"
                              :class="authPrimaryButtonClass"
                            >
                              <svg
                                v-if="isLoading" class="inline-block mr-3 -ml-1 w-5 h-5 text-white align-middle animate-spin"
                                xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" data-test="loading"
                              >
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                <path
                                  class="opacity-75" fill="currentColor"
                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                />
                              </svg>
                              {{ t('log-in') }}
                            </button>
                          </div>
                        </div>

                        <div :class="authPanelClass">
                          <a
                            v-if="!isMobile"
                            :href="registerUrl"
                            data-test="register"
                            :class="authInlineLinkClass"
                          >
                            {{ t('create-a-free-account') }}
                          </a>
                          <button
                            type="button"
                            data-test="forgot-password"
                            :class="authInlineLinkClass"
                            @click="goToForgotPassword"
                          >
                            {{ t('forgot') }} {{ t('password') }} ?
                          </button>
                        </div>
                      </div>
                    </FormKit>
                  </div>
                </div>
              </div>

              <!-- Step 3: 2FA -->
              <div v-else key="step-2fa" :class="authStepCardClass">
                <div :class="authCardBodyClass">
                  <FormKit id="2fa-account" type="form" :actions="false" autocapitalize="off" data-test="2fa-form" @submit="handleMfaSubmit">
                    <div class="space-y-5 text-slate-500 dark:text-slate-300">
                      <FormKit
                        type="text" name="code" :disabled="isLoading"
                        :prefix-icon="mfaIcon" inputmode="text" :label="t('2fa-code')"
                        :validation-rules="{ mfa_code_validation }"
                        :validation-messages="{
                          mfa_code_validation: t('login-2fa-code-invalid'),
                        }"
                        placeholder="xxx xxx"
                        autocomplete="off"
                        validation="required|mfa_code_validation"
                        validation-visibility="live"
                        data-test="2fa-code"
                      />
                      <FormKitMessages />
                      <div>
                        <div class="inline-flex justify-center items-center w-full">
                          <button
                            type="submit" data-test="verify" :disabled="isLoading" :aria-busy="isLoading ? 'true' : 'false'"
                            :class="authPrimaryButtonClass"
                          >
                            <svg
                              v-if="isLoading" class="inline-block mr-3 -ml-1 w-5 h-5 text-white align-middle animate-spin"
                              xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" data-test="loading"
                            >
                              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                              <path
                                class="opacity-75" fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            {{ t('verify') }}
                          </button>
                        </div>
                      </div>

                      <div :class="authPanelClass">
                        <button type="button" class="appearance-none" :class="authInlineLinkClass" @click="goback">
                          {{ t('go-back') }}
                        </button>
                      </div>
                    </div>
                  </FormKit>
                </div>
              </div>
            </Transition>

            <!-- Footer (visible for email and credentials steps) -->
            <section v-if="statusAuth !== '2fa'" class="flex flex-col items-center mt-6">
              <div class="mx-auto">
                <LangSelector />
              </div>
              <button class="mt-3" :class="authGhostButtonClass" @click="openSupport">
                {{ t("support") }}
              </button>
              <button v-if="isMobile" class="mt-3" :class="authGhostButtonClass" @click="openScan">
                {{ t("test-bundle") }}
              </button>
            </section>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
