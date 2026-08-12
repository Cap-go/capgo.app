<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import VueTurnstile from 'vue-turnstile'
import IconCheck from '~icons/lucide/check'
import IconLoader from '~icons/lucide/loader-2'
import IconShield from '~icons/lucide/shield-check'
import IconX from '~icons/lucide/x'
import { authGhostButtonClass, authInsetCardClass, authPrimaryButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import Toggle from '~/components/Toggle.vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { completeInviteSessionHandoff } from '~/utils/invites'

const { t } = useI18n()
const route = useRoute('/invitation')
const router = useRouter()
const turnstileToken = ref('')
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const captchaComponent = ref<InstanceType<typeof VueTurnstile> | null>(null)

// Form data
const password = ref('')
const inviteMagicString = ref('')
const inviteRow = ref<Database['public']['Functions']['get_invite_by_magic_lookup']['Returns'][0] | null>(null)
const isLoading = ref(false)
const isFetchingInvite = ref(true)
const isError = ref(null) as Ref<string | null>
// Terms and marketing acceptance
const acceptTerms = ref(false)
const acceptMarketing = ref(true)
const showTermsError = ref(false)

// Password validation
const hasMinLength = computed(() => password.value.length >= 6)
const hasUppercase = computed(() => /[A-Z]/.test(password.value))
const hasNumber = computed(() => /\d/.test(password.value))
const hasSymbols = computed(() => {
  // Improved regex to match special characters
  // Count each special character individually
  let symbolCount = 0
  const specialChars = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/g
  const matches = password.value.match(specialChars)

  // Return the count of matches, or 0 if no matches
  symbolCount = matches ? matches.length : 0

  return symbolCount >= 1
})

const isPasswordValid = computed(() =>
  hasMinLength.value
  && hasUppercase.value
  && hasNumber.value
  && hasSymbols.value,
)
const invitationTitle = computed(() => inviteRow.value ? `${t('welcome-to')} Capgo` : t('accept-invitation'))
const inviteDescription = computed(() => inviteRow.value ? t('invitation-page-description') : '')
const passwordChecks = computed(() => [
  { label: t('at-least-6-characters'), passed: hasMinLength.value },
  { label: t('at-least-one-uppercase-letter'), passed: hasUppercase.value },
  { label: t('at-least-one-number'), passed: hasNumber.value },
  { label: t('at-least-one-special-character'), passed: hasSymbols.value },
])
const organizationInitials = computed(() => {
  const name = inviteRow.value?.org_name?.trim() ?? ''
  if (!name)
    return 'CG'

  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('')
})

onMounted(async () => {
  const supabase = useSupabase()
  // Sign out any existing session before the form is usable so a later
  // sign-out cannot wipe the session established after invite accept.
  const { data: claimsData } = await supabase.auth.getClaims()
  if (claimsData?.claims?.sub)
    await supabase.auth.signOut()

  if (route.query.invite_magic_string) {
    inviteMagicString.value = route.query.invite_magic_string as string
    const { data, error } = await supabase.rpc('get_invite_by_magic_lookup', {
      lookup: inviteMagicString.value,
    }).single()

    if (error) {
      captchaComponent.value?.reset()
      console.error('Error fetching invite:', error)
      isError.value = error.message
      isFetchingInvite.value = false
    }
    else {
      inviteRow.value = data
      isFetchingInvite.value = false
    }
  }
  else {
    isFetchingInvite.value = false
  }
})

// Submit function
async function submitForm() {
  if (!isPasswordValid.value)
    return

  // Check if terms are accepted
  if (!acceptTerms.value) {
    showTermsError.value = true
    return
  }

  showTermsError.value = false

  try {
    // Show loading indicator
    isLoading.value = true

    // Call the backend API to accept the invitation using Supabase Functions
    const { data, error } = await invokeCapgoApi('private/accept_invitation', {
      allowAnonymous: true,
      body: {
        password: password.value,
        magic_invite_string: inviteMagicString.value,
        opt_for_newsletters: acceptMarketing.value,
        captchaToken: turnstileToken.value,
      },
    })

    if (error) {
      captchaComponent.value?.reset()
      throw new Error(error.message || 'Failed to accept invitation')
    }

    if (data?.access_token && data?.refresh_token) {
      const supabase = useSupabase()
      try {
        await completeInviteSessionHandoff(
          tokens => supabase.auth.setSession(tokens),
          () => router.replace('/login'),
          data,
        )
      }
      catch {
        // Invite is already consumed. Keep tokens on /login so the user can
        // retry instead of being stuck on a generic accept error.
        await router.replace(`/login?access_token=${encodeURIComponent(data.access_token)}&refresh_token=${encodeURIComponent(data.refresh_token)}`)
      }
    }
    else {
      captchaComponent.value?.reset()
      throw new Error('No tokens received from server')
    }
  }
  catch (error: unknown) {
    captchaComponent.value?.reset()
    console.error('Error accepting invitation:', error)
    isError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    isLoading.value = false
  }
}

function joinCapgo() {
  window.location.href = 'https://capgo.app/register/'
}

// Open ToS and Privacy Policy in new tabs
function openTos() {
  window.open('https://capgo.app/tos/', '_blank')
}

function openPrivacy() {
  window.open('https://capgo.app/privacy/', '_blank')
}
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-xl"
    :card-kicker="t('accept-invitation')"
    :card-title="invitationTitle"
    :card-description="inviteDescription"
  >
    <div v-if="isFetchingInvite" class="flex items-center justify-center py-12">
      <Spinner size="w-14 h-14" />
    </div>

    <div v-else-if="inviteRow" class="space-y-5 text-slate-500 dark:text-slate-300">
      <div :class="authInsetCardClass">
        <div class="flex items-start gap-4">
          <img v-if="inviteRow.org_logo" :src="inviteRow.org_logo" alt="organization logo" class="h-16 w-16 rounded-2xl border border-slate-200 object-cover dark:border-slate-700">
          <div v-else class="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-900 text-sm font-semibold tracking-[0.18em] text-white">
            {{ organizationInitials }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase dark:text-slate-400">
              {{ t('organization-name') }}
            </p>
            <p class="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
              {{ inviteRow.org_name }}
            </p>
            <div class="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              <IconShield class="h-3.5 w-3.5" />
              {{ t('your-role-in-org') }}: {{ inviteRow.role.replace('_', ' ') }}
            </div>
          </div>
        </div>
      </div>

      <div :class="authInsetCardClass">
        <label for="password" class="block text-sm font-medium text-slate-800 dark:text-slate-100">{{ t('password-colon') }}</label>
        <input
          id="password"
          v-model="password"
          type="password"
          :placeholder="t('password-placeholder')"
          autocomplete="new-password"
          class="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-azure-400 focus:ring-2 focus:ring-azure-100 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-azure-400 dark:focus:ring-azure-200/20"
        >

        <div class="mt-4 grid gap-2">
          <div
            v-for="entry in passwordChecks"
            :key="entry.label"
            class="flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors"
            :class="entry.passed
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-200'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200'"
          >
            <component :is="entry.passed ? IconCheck : IconX" class="h-4 w-4 shrink-0" />
            <span>{{ entry.label }}</span>
          </div>
        </div>
      </div>

      <div :class="authInsetCardClass">
        <div class="space-y-4">
          <label class="flex items-start gap-3">
            <Toggle :value="acceptTerms" class="mt-0.5 shrink-0" @update:value="acceptTerms = !acceptTerms" />
            <span class="text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('accept-terms-of-service-and-privacy-policy') }}
              <button type="button" class="font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]" @click="openTos">
                {{ t('terms-of-service') }}
              </button>
              {{ t('and') }}
              <button type="button" class="font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]" @click="openPrivacy">
                {{ t('privacy-policy') }}
              </button>
            </span>
          </label>

          <div v-if="showTermsError" class="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200">
            {{ t('accept-terms-of-service-and-privacy-policy') }}
          </div>

          <label class="flex items-start gap-3">
            <Toggle :value="acceptMarketing" class="mt-0.5 shrink-0" @update:value="acceptMarketing = !acceptMarketing" />
            <span class="text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('accept-email-newsletter-and-future-marketing-offers') }}
            </span>
          </label>
        </div>
      </div>

      <div v-if="captchaKey" class="overflow-hidden">
        <VueTurnstile ref="captchaComponent" v-model="turnstileToken" size="flexible" :site-key="captchaKey" />
      </div>

      <button
        :disabled="isLoading || !isPasswordValid || !acceptTerms"
        :aria-busy="isLoading ? 'true' : 'false'"
        :class="authPrimaryButtonClass"
        @click="submitForm"
      >
        <IconLoader v-if="isLoading" class="h-5 w-5 animate-spin" />
        <span>{{ t('accept-invitation') }}</span>
      </button>
    </div>

    <div v-else class="space-y-5 text-center text-slate-500 dark:text-slate-300">
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200">
        <IconX class="h-7 w-7" />
      </div>
      <p class="text-xl font-semibold text-slate-900 dark:text-white">
        {{ t('invitation-page-not-found') }}
      </p>
      <p class="text-sm leading-6">
        {{ t('you-can-still-join-capgo') }}
      </p>
      <div v-if="isError" class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200">
        {{ isError }}
      </div>
      <button :class="authSecondaryButtonClass" @click="joinCapgo">
        {{ t('join-capgo') }}
      </button>
    </div>

    <template #footer>
      <section class="mt-6 flex flex-col items-center">
        <div class="mx-auto">
          <LangSelector />
        </div>
        <button class="mt-3" :class="authGhostButtonClass" @click="openSupport">
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
