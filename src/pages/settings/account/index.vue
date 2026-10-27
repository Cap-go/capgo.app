<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { Capacitor } from '@capacitor/core'
import dayjs from 'dayjs'
import { computed, onMounted, ref, unref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconVersion from '~icons/heroicons/arrow-path'
import IconEmail from '~icons/heroicons/envelope'
import IconFlag from '~icons/heroicons/flag'
import IconName from '~icons/heroicons/user'
import GitHubProfileDialog from '~/components/dashboard/GitHubProfileDialog.vue'
import FormField from '~/components/forms/FormField.vue'
import VueTurnstile from '~/components/VueTurnstile.vue'
import { getCurrentPlanNameOrg, isPayingOrg, useConsole } from '~/services/console'
import { getRecentEmailOtpVerification } from '~/services/emailOtp'
import { getFormatLocaleOptions, resolveFormatLocale } from '~/services/formatLocale'
import { pickPhoto, takePhoto } from '~/services/photos'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { isSuperAdminRole, useOrganizationStore } from '~/stores/organization'
import { rules, validateField } from '~/utils/formValidation'
import { safeResetTurnstile } from '~/utils/turnstile'
// tabs handled by settings layout

const version = import.meta.env.VITE_APP_VERSION
const { locale, t } = useI18n()
const capgo = useConsole()
const displayStore = useDisplayStore()
displayStore.NavTitle = t('account')
const router = useRouter()
const route = useRoute()
const main = useMainStore()
const dialogStore = useDialogV2Store()
const organizationStore = useOrganizationStore()
const isLoading = ref(false)
const isDeletingAccount = ref(false)
const deleteAccountPassword = ref('')
const deleteAccountCaptchaToken = ref('')
const deleteAccountCaptchaRef = ref<InstanceType<typeof VueTurnstile> | null>(null)
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const organizationsToDelete = ref<string[]>([])
const formatLocaleOptions = computed(() => getFormatLocaleOptions(locale.value))

// Account form values, seeded from the user profile.
const firstName = ref('')
const lastName = ref('')
const accountEmail = ref('')
const country = ref('')
const discordUsername = ref('')
const formatLocaleValue = ref('')
const accountSubmitted = ref(false)
const accountFormErrors = ref<string[]>([])

function seedAccountForm() {
  const user = main.user
  firstName.value = user?.first_name ?? ''
  lastName.value = user?.last_name ?? ''
  accountEmail.value = user?.email ?? ''
  country.value = user?.country ?? ''
  discordUsername.value = user?.discord_username ?? ''
  formatLocaleValue.value = resolveFormatLocale(user?.format_locale)
}
seedAccountForm()
// The profile can load after the page mounts.
watch(() => main.user?.id, seedAccountForm)

const firstNameErrors = computed(() => validateField(firstName.value, [rules.required(t('first-name'), { trim: true })]))
const lastNameErrors = computed(() => validateField(lastName.value, [rules.required(t('last-name'), { trim: true })]))
const accountEmailErrors = computed(() => validateField(accountEmail.value, [rules.required(t('email'), { trim: true }), rules.email()]))
const countryErrors = computed(() => validateField(country.value, [rules.required(t('country'), { trim: true })]))
const discordUsernameErrors = computed(() => validateField(discordUsername.value, [rules.length(t('discord-username'), 0, 32)]))
const paidOrganizationsToDelete = ref<Array<{ name: string, planName: string }>>([])
const githubDialog = useTemplateRef('githubDialog')
const githubUsername = computed(() => unref(githubDialog.value?.githubUsername) ?? '')

function openGitHubProfileDialog() {
  githubDialog.value?.openGitHubProfileDialog()
}

async function redirectToEmailVerification() {
  await router.push({
    path: '/resend_email',
    query: {
      reason: 'email_not_verified',
      return_to: '/settings/account',
      purpose: 'delete_account',
    },
  })
}

async function ensureRecentEmailVerification() {
  if (!main.auth?.id)
    return false

  try {
    const { isVerified } = await getRecentEmailOtpVerification(capgo, main.auth.id)
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

async function checkOrganizationImpact() {
  // Dashboard statistics never load for accounts without organizations.
  await organizationStore.awaitInitialLoad()

  // Get all organizations where user is super_admin
  const superAdminOrgs = organizationStore.organizations.filter(org => isSuperAdminRole(org.role))

  if (superAdminOrgs.length === 0) {
    return { orgsToBeDeleted: [], paidOrgsToBeDeleted: [], canProceed: true }
  }

  const orgsToBeDeleted: string[] = []
  const paidOrgsToBeDeleted: Array<{ name: string, planName: string, orgId: string }> = []

  // Check each organization to see if user is the only super_admin
  for (const org of superAdminOrgs) {
    try {
      const { data: members, error } = await capgo
        .rpc('get_org_members_rbac', { p_org_id: org.gid })

      if (error) {
        console.error('Error getting RBAC org members:', error)
        continue
      }

      const superAdminCount = members.filter(member =>
        !member.is_invite && !member.is_tmp && isSuperAdminRole(member.role_name),
      ).length

      // If user is the only super_admin, this org will be deleted
      if (superAdminCount === 1) {
        orgsToBeDeleted.push(org.name)

        // Check if this organization has a paid subscription
        try {
          const isPaying = await isPayingOrg(org.gid)
          if (isPaying) {
            const planNameFromDb = await getCurrentPlanNameOrg(org.gid)
            // Get the actual plan object to get the real plan name
            const actualPlan = main.plans.find(p => p.name === planNameFromDb)
            const planName = actualPlan?.name || planNameFromDb || 'Unknown Plan'

            paidOrgsToBeDeleted.push({
              name: org.name,
              planName,
              orgId: org.gid,
            })
          }
        }
        catch (error) {
          console.error('Error checking payment status for org:', org.name, error)
        }
      }
    }
    catch (error) {
      console.error('Error checking organization:', org.name, error)
    }
  }

  return { orgsToBeDeleted, paidOrgsToBeDeleted, canProceed: true }
}

async function deleteAccount() {
  if (!await ensureRecentEmailVerification()) {
    return
  }

  // First, check organization impact
  const { orgsToBeDeleted, paidOrgsToBeDeleted, canProceed } = await checkOrganizationImpact()

  if (!canProceed) {
    toast.error(t('something-went-wrong-try-again-later'))
    return
  }

  // Show warning if organizations will be deleted
  if (orgsToBeDeleted.length > 0) {
    // Store the organizations list for the teleport
    organizationsToDelete.value = orgsToBeDeleted

    dialogStore.openDialog({
      id: 'delete-account-warning-orgs',
      title: t('warning-organizations-will-be-deleted'),
      description: t('warning-organizations-will-be-deleted-message'),
      size: 'lg',
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
        {
          text: t('understand-and-continue'),
          role: 'danger',
        },
      ],
    })

    const cancelled = await dialogStore.onDialogDismiss()
    if (cancelled) {
      organizationsToDelete.value = []
      return
    }
    organizationsToDelete.value = []
  }

  // Show subscription cancellation warning if there are paid organizations
  if (paidOrgsToBeDeleted.length > 0) {
    // Store the paid organizations list for the teleport
    paidOrganizationsToDelete.value = paidOrgsToBeDeleted.map(org => ({
      name: org.name,
      planName: org.planName,
    }))

    dialogStore.openDialog({
      id: 'delete-account-warning-paid',
      title: t('warning-paid-subscriptions'),
      description: t('warning-paid-subscriptions-message'),
      size: 'lg',
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
        {
          text: t('cancel-subscriptions-and-continue'),
          role: 'danger',
        },
      ],
    })

    const cancelled = await dialogStore.onDialogDismiss()
    if (cancelled) {
      paidOrganizationsToDelete.value = []
      return
    }
    paidOrganizationsToDelete.value = []

    // TODO: Here we would implement subscription cancellation logic
    // For now, we just continue to the final confirmation
  }

  // Show final confirmation
  deleteAccountPassword.value = ''
  deleteAccountCaptchaToken.value = ''
  safeResetTurnstile(deleteAccountCaptchaRef.value)
  dialogStore.openDialog({
    id: 'delete-account-confirm',
    title: t('delete-account'),
    description: '', // We'll use Teleport for custom content
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('i-am-sure'),
        role: 'danger',
        preventClose: true,
        handler: async () => {
          const success = await performAccountDeletion(deleteAccountPassword.value)
          if (success) {
            deleteAccountPassword.value = ''
            dialogStore.closeDialog({ text: t('i-am-sure'), role: 'danger' })
          }
          return success
        },
      },
    ],
  })
  const dismissed = await dialogStore.onDialogDismiss()
  deleteAccountPassword.value = ''
  deleteAccountCaptchaToken.value = ''
  safeResetTurnstile(deleteAccountCaptchaRef.value)
  return dismissed
}

async function performAccountDeletion(password: string) {
  if (!main.auth || main.auth?.email == null)
    return false
  const capgoClient = useConsole()

  if (!password) {
    toast.error(t('password-placeholder'))
    return false
  }

  if (captchaKey.value && !deleteAccountCaptchaToken.value) {
    toast.error(t('captcha-required'))
    return false
  }

  if (isDeletingAccount.value)
    return false

  isDeletingAccount.value = true
  try {
    const { error: signInError } = await capgo.auth.signInWithPassword({
      email: main.auth.email,
      password,
      options: captchaKey.value ? { captchaToken: deleteAccountCaptchaToken.value } : undefined,
    })
    if (signInError) {
      deleteAccountCaptchaToken.value = ''
      safeResetTurnstile(deleteAccountCaptchaRef.value)
      if (signInError.message.includes('captcha')) {
        toast.error(t('captcha-fail'))
        return false
      }
      toast.error(t('invalid-auth'))
      return false
    }

    const { data: claimsData, error: claimsError } = await capgo.auth.getClaims()
    const userId = claimsData?.claims?.sub
    if (claimsError || !userId) {
      toast.error(t('something-went-wrong-try-again-later'))
      return false
    }

    const { data: user } = await capgoClient
      .from('users')
      .select()
      .eq('id', userId)
      .single()
    if (!user) {
      toast.error(t('something-went-wrong-try-again-later'))
      return false
    }

    if (user.email.endsWith('review@capgo.app') && Capacitor.isNativePlatform()) {
      const { error: banErr } = await capgo
        .from('users')
        .update({ ban_time: dayjs().add(5, 'minutes').toDate().toISOString() })
        .eq('id', user.id)

      if (banErr) {
        console.error('Cannot set ban duration', banErr)
        toast.error(t('something-went-wrong-try-again-later'))
        return false
      }

      await main.logout()
      router.replace('/login')
      return true
    }

    // Delete user using RPC function
    const { error: deleteError } = await capgo.rpc('delete_user')

    if (deleteError) {
      console.error('Delete error:', deleteError)
      if (deleteError.message?.includes('email_not_verified')) {
        await redirectToEmailVerification()
        return false
      }
      if (deleteError.message?.includes('reauth_required')) {
        deleteAccountCaptchaToken.value = ''
        safeResetTurnstile(deleteAccountCaptchaRef.value)
        toast.error(t('invalid-auth'))
        return false
      }
      toast.error(t('something-went-wrong-try-again-later'))
      return false
    }

    // Ensure the deleted account session is cleared to avoid being stuck on /accountDisabled
    await main.logout()
    toast.success(t('account-deleted-successfully'))
    router.replace('/login')
    return true
  }
  catch (error) {
    console.error(error)
    toast.error(t('something-went-wrong-try-again-later'))
    return false
  }
  finally {
    isDeletingAccount.value = false
  }
}

async function copyAccountId() {
  try {
    await navigator.clipboard.writeText(main!.user!.id)
    console.log('displayStore.messageToast', displayStore.messageToast)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
    // Display a modal with the copied key
    dialogStore.openDialog({
      title: t('cannot-copy'),
      description: main!.user!.id,
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
  }
}

const acronym = computed(() => {
  let res = 'MD'
  if (main.user?.first_name && main.user.last_name)
    res = main.user?.first_name[0] + main.user?.last_name[0]
  else if (main.user?.first_name)
    res = main.user?.first_name[0]
  else if (main.user?.last_name)
    res = main.user?.last_name[0]
  return res.toUpperCase()
})

async function presentActionSheet() {
  dialogStore.openDialog({
    title: t('change-your-picture'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
        handler: () => {
          console.log('Cancel clicked')
        },
      },
      {
        text: t('button-camera'),
        role: 'primary',
        handler: () => {
          takePhoto('update-account', isLoading, 'user', t('something-went-wrong-try-again-later'))
        },
      },
      {
        text: t('button-browse'),
        role: 'secondary',
        handler: () => {
          pickPhoto('update-account', isLoading, 'user', t('something-went-wrong-try-again-later'))
        },
      },
    ],
  })
  return dialogStore.onDialogDismiss()
}

async function onSubmit() {
  accountSubmitted.value = true
  const hasErrors = [firstNameErrors, lastNameErrors, accountEmailErrors, countryErrors, discordUsernameErrors]
    .some(errors => errors.value.length > 0)
  if (hasErrors)
    return
  accountFormErrors.value = []
  await submit({
    first_name: firstName.value,
    last_name: lastName.value,
    email: accountEmail.value,
    country: country.value,
    discord_username: discordUsername.value,
    format_locale: formatLocaleValue.value,
  })
}

async function submit(form: { first_name: string, last_name: string, email: string, country: string, discord_username: string, format_locale: string }) {
  if (isLoading.value || !main.user?.id)
    return

  const formatLocale = resolveFormatLocale(form.format_locale)
  const currentFormatLocale = resolveFormatLocale(main.user?.format_locale)
  if (form.first_name === main.user?.first_name
    && form.last_name === main.user?.last_name
    && form.email === main.user?.email
    && form.country === main.user?.country
    && (form.discord_username || null) === main.user?.discord_username
    && formatLocale === currentFormatLocale) {
    return
  }
  isLoading.value = true

  const updateData: Database['public']['Tables']['users']['Insert'] = {
    id: main.user?.id,
    first_name: form.first_name,
    last_name: form.last_name,
    email: main.user.email,
    country: form.country,
    discord_username: form.discord_username || null,
    // Keep "follow UI language" (null) unless the user picked a different format.
    format_locale: !main.user.format_locale && formatLocale === currentFormatLocale ? null : formatLocale,
  }

  if (main.user?.email !== form.email) {
    const data = await capgo.auth.updateUser({ email: form.email })
    seedAccountForm()
    accountSubmitted.value = false
    if (data.error && data.error.name === 'AuthApiError') {
      isLoading.value = false
      return toast.error('email already taken')
    }
    toast.success('A confirmation email was sent click to link to confirm your new email', {
      duration: 10000,
    })
    // public.users.email follows the auth email; it syncs once the change is confirmed.
  }

  const { data: usr, error: dbError } = await capgo
    .from('users')
    .upsert(updateData, { onConflict: 'id' })
    .select()
    .single()

  if (dbError || !usr) {
    isLoading.value = false
    accountFormErrors.value = [t('account-error')]
    return
  }
  else {
    toast.success(t('account-updated-succ'))
  }
  main.user = usr
  isLoading.value = false
}

async function logOut() {
  dialogStore.openDialog({
    title: t('are-u-sure'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('logout'),
        role: 'danger',
        id: 'confirm-button',
        handler: async () => {
          await main.logout()
          await router.replace('/login')
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}

onMounted(async () => {
  // Auto-redirect to Manage 2FA page if setup2fa query param is present
  if (route.query.setup2fa === 'true') {
    router.replace('/settings/account/manage-2fa?setup2fa=true')
  }
})
</script>

<template>
  <div>
    <div class="flex flex-col h-full pb-8 overflow-hidden overflow-y-auto bg-white border shadow-sm md:pb-0 max-h-fit grow md:rounded-xl dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
      <form id="update-account" novalidate @submit.prevent="onSubmit">
        <!-- Panel body -->
        <div class="p-6 space-y-6">
          <h2 class="mb-5 text-2xl font-bold dark:text-white text-slate-800">
            {{ t('personal-information') }}
          </h2>
          <div class="dark:text-gray-100">
            {{ t('you-can-change-your-') }}
          </div>
          <!-- Picture -->
          <section>
            <div class="flex items-center">
              <div class="mr-4">
                <img
                  v-if="main.user?.image_url" class="object-cover w-20 h-20 d-mask d-mask-squircle" :src="main.user?.image_url"
                  width="80" height="80" alt="User upload"
                >
                <div v-else class="p-6 text-xl bg-gray-700 d-mask d-mask-squircle">
                  <span class="font-medium text-gray-300">
                    {{ acronym }}
                  </span>
                </div>
              </div>
              <button id="change-org-pic" type="button" class="px-3 py-2 text-xs font-medium text-center text-gray-700 border rounded-lg cursor-pointer dark:text-white hover:bg-gray-100 focus:ring-4 focus:ring-blue-300 border-slate-500 dark:hover:bg-gray-600 dark:focus:ring-blue-800 focus:outline-hidden" @click="presentActionSheet">
                {{ t('change') }}
              </button>
            </div>
          </section>

          <!-- Personal Info -->
          <section>
            <div class="mt-5 space-y-4 sm:flex sm:items-center sm:space-y-0 sm:space-x-4">
              <div class="sm:w-1/2">
                <FormField
                  v-model="firstName"
                  type="text"
                  name="first_name"
                  autocomplete="given-name"
                  :prefix-icon="IconName"
                  :disabled="isLoading"
                  :errors="firstNameErrors"
                  :submitted="accountSubmitted"
                  enterkeyhint="next"
                  autofocus
                  :label="t('first-name')"
                />
              </div>
              <div class="sm:w-1/2">
                <FormField
                  v-model="lastName"
                  type="text"
                  name="last_name"
                  autocomplete="family-name"
                  :prefix-icon="IconName"
                  :disabled="isLoading"
                  enterkeyhint="next"
                  :errors="lastNameErrors"
                  :submitted="accountSubmitted"
                  :label="t('last-name')"
                />
              </div>
            </div>
            <div class="mt-5 space-y-4 sm:flex sm:items-center sm:space-y-0 sm:space-x-4">
              <div class="sm:w-1/2">
                <FormField
                  v-model="accountEmail"
                  type="email"
                  name="email"
                  :prefix-icon="IconEmail"
                  enterkeyhint="next"
                  :errors="accountEmailErrors"
                  :submitted="accountSubmitted"
                  :label="t('email')"
                />
              </div>
              <div class="sm:w-1/2">
                <FormField
                  v-model="country"
                  type="text"
                  name="country"
                  :prefix-icon="IconFlag"
                  :disabled="isLoading"
                  enterkeyhint="send"
                  :errors="countryErrors"
                  :submitted="accountSubmitted"
                  :label="t('country')"
                />
              </div>
            </div>
            <div class="mt-5 space-y-4 sm:flex sm:items-center sm:space-y-0 sm:space-x-4">
              <div class="sm:w-1/2">
                <FormField
                  v-model="discordUsername"
                  type="text"
                  name="discord_username"
                  autocomplete="off"
                  :disabled="isLoading"
                  :errors="discordUsernameErrors"
                  :submitted="accountSubmitted"
                  enterkeyhint="next"
                  :label="t('discord-username')"
                  :help="t('discord-username-help')"
                />
              </div>
              <div class="sm:w-1/2">
                <FormField
                  type="text"
                  name="github_username"
                  :model-value="githubUsername"
                  autocomplete="off"
                  :disabled="isLoading"
                  readonly
                  enterkeyhint="send"
                  :label="t('github-username')"
                  :help="t('github-username-help')"
                  :placeholder="t('github-username-select')"
                  @click="openGitHubProfileDialog"
                  @keydown.enter.prevent="openGitHubProfileDialog"
                />
              </div>
            </div>
            <ul v-if="accountFormErrors.length" role="alert" class="mb-1.5">
              <li v-for="e in accountFormErrors" :key="e" class="text-xs text-red-600 dark:text-red-400">
                {{ e }}
              </li>
            </ul>
          </section>
          <h3 class="mt-2 mb-5 text-2xl font-bold dark:text-white text-slate-800">
            {{ t('settings') }}
          </h3>
          <!-- Language Info -->
          <section class="flex flex-col md:flex-row md:items-center items-left">
            <p class="">
              {{ t('language') }}:
            </p>
            <div class="md:ml-6">
              <LangSelector placement="bottom" />
            </div>
          </section>

          <section class="flex flex-col gap-2 md:flex-row md:items-start items-left">
            <div class="md:w-48">
              <p class="dark:text-white text-slate-800">
                {{ t('date-number-format') }}:
              </p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ t('date-number-format-help') }}
              </p>
            </div>
            <div class="md:ml-6 md:min-w-96">
              <select
                id="account-format-locale"
                v-model="formatLocaleValue"
                name="format_locale"
                class="d-select w-full"
                :disabled="isLoading"
                :aria-label="t('date-number-format')"
              >
                <option v-for="option in formatLocaleOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
          </section>

          <div class="flex flex-col md:flex-row md:items-center items-left">
            <p class="dark:text-white text-slate-800">
              {{ t('account-id') }}:
            </p>
            <div class="md:ml-6">
              <button type="button" class="px-3 py-2 text-xs font-medium text-center text-gray-700 border rounded-lg cursor-pointer dark:text-white hover:bg-gray-100 focus:ring-4 focus:ring-blue-300 border-slate-500 dark:hover:bg-gray-600 dark:focus:ring-blue-800 focus:outline-hidden" @click.prevent="copyAccountId()">
                {{ t('copy-account-id') }}
              </button>
            </div>
          </div>
          <div class="flex mb-3 text-xs font-semibold uppercase dark:text-white text-slate-400">
            <IconVersion /> <span class="pl-2"> {{ version }}</span>
          </div>
          <!-- Panel footer -->
          <footer>
            <div class="flex flex-col px-2 py-5 border-t md:px-6 border-slate-300">
              <div class="flex flex-wrap gap-3 items-center justify-between">
                <button
                  type="button"
                  class="d-btn p-2 text-gray-700 border rounded-lg cursor-pointer dark:text-white hover:bg-gray-100 border-slate-500 dark:hover:bg-gray-600"
                  @click="logOut()"
                >
                  {{ t('sign-out') }}
                </button>
                <div class="flex">
                  <button type="button" class="p-2 text-red-600 border border-red-400 rounded-lg hover:text-white hover:bg-red-600" @click="deleteAccount()">
                    {{ t('delete-account') }}
                  </button>
                  <button
                    class="p-2 ml-3 text-white bg-blue-500 rounded-lg hover:bg-blue-600 d-btn"
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
            </div>
          </footer>
        </div>
      </form>
    </div>

    <!-- Teleport for Organization Deletion Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'delete-account-warning-orgs'" to="#dialog-v2-content" defer>
      <div class="p-4 mt-4 border border-red-200 rounded-lg bg-red-50 dark:border-red-800 dark:bg-red-900/20">
        <h4 class="mb-3 font-semibold text-red-800 dark:text-red-200">
          {{ t('organizations-to-be-deleted') }}:
        </h4>
        <ul class="space-y-2">
          <li v-for="orgName in organizationsToDelete" :key="orgName" class="flex items-center text-red-700 dark:text-red-300">
            <span class="w-2 h-2 mr-3 bg-red-500 rounded-full" />
            <span class="font-medium">{{ orgName }}</span>
          </li>
        </ul>
      </div>
    </Teleport>

    <!-- Teleport for Paid Subscriptions Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'delete-account-warning-paid'" to="#dialog-v2-content" defer>
      <div class="p-4 mt-4 border border-orange-200 rounded-lg bg-orange-50 dark:border-orange-800 dark:bg-orange-900/20">
        <h4 class="mb-3 font-semibold text-orange-800 dark:text-orange-200">
          {{ t('paid-subscriptions-to-cancel') }}:
        </h4>
        <ul class="space-y-3">
          <li v-for="org in paidOrganizationsToDelete" :key="org.name" class="flex items-center justify-between text-orange-700 dark:text-orange-300">
            <div class="flex items-center">
              <span class="w-2 h-2 mr-3 bg-orange-500 rounded-full" />
              <span class="font-medium">{{ org.name }}</span>
            </div>
            <span class="px-2 py-1 text-sm bg-orange-100 rounded-full dark:bg-orange-800">
              {{ org.planName }}
            </span>
          </li>
        </ul>
      </div>
    </Teleport>

    <!-- Teleport for Final Account Deletion Warning -->
    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'delete-account-confirm'" to="#dialog-v2-content" defer>
      <div class="text-base text-gray-500 dark:text-gray-400">
        <p class="mb-4">
          This action cannot be undone. Your account and all associated data will be permanently deleted.
        </p>
        <p class="font-medium text-gray-700 dark:text-gray-300">
          Your account will be deleted after 30 days
        </p>
        <div class="mt-6">
          <label for="delete-account-password" class="block mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('current-password') }}
          </label>
          <input
            id="delete-account-password"
            v-model="deleteAccountPassword"
            type="password"
            :placeholder="t('password-placeholder')"
            :aria-label="t('current-password')"
            class="w-full p-3 border border-gray-300 rounded-lg dark:text-white dark:bg-gray-800 dark:border-gray-600"
            autocomplete="current-password"
            @keydown.enter="$event.preventDefault()"
          >
          >
        </div>
        <div v-if="captchaKey" class="mt-4">
          <label class="block mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {{ t('captcha') }}
          </label>
          <VueTurnstile
            ref="deleteAccountCaptchaRef"
            v-model="deleteAccountCaptchaToken"
            size="flexible"
            :site-key="captchaKey"
          />
        </div>
      </div>
    </Teleport>

    <GitHubProfileDialog ref="githubDialog" dialog-id="github-profile" />
  </div>
</template>

<route lang="yaml">
  meta:
    layout: settings
      </route>
