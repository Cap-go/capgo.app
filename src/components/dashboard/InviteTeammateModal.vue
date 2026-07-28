<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import VueTurnstile from 'vue-turnstile'
import { invokeCapgoApi } from '~/services/capgoApi'
import { useSupabase } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'
import { notifyExistingUserInvite, resolveInviteNewUserErrorMessage } from '~/utils/invites'

interface InviteSuccessPayload {
  email: string
  firstName: string
  lastName: string
}

const props = withDefaults(defineProps<{
  inviteKind?: 'generic' | 'technical'
}>(), {
  inviteKind: 'generic',
})

const emit = defineEmits<{
  success: [payload: InviteSuccessPayload]
}>()

const { t } = useI18n()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()

const inviteEmail = ref('')
const inviteFirstName = ref('')
const inviteLastName = ref('')
const inviteCaptchaToken = ref('')
const inviteCaptchaElement = ref<InstanceType<typeof VueTurnstile> | null>(null)
const captchaKey = ref(import.meta.env.VITE_CAPTCHA_KEY)
const shouldUseCaptcha = computed(() => Boolean(captchaKey.value))
const isInviting = ref(false)
const existingUserInviteRole = 'org_admin'
const newUserInviteRole = 'org_admin'
const emailDialogTitle = computed(() => props.inviteKind === 'technical'
  ? t('onboarding-invite-option-modal-title')
  : t('invite-teammate-modal-title'))
const emailDialogDescription = computed(() => props.inviteKind === 'technical'
  ? t('onboarding-invite-option-dialog-desc')
  : t('invite-teammate-modal-description'))

// Dialog state tracking
const isEmailDialogOpen = ref(false)
const isFullDetailsDialogOpen = ref(false)

function openDialog() {
  resetInviteForm()
  showEmailDialog()
}

function showEmailDialog() {
  isEmailDialogOpen.value = true
  isFullDetailsDialogOpen.value = false

  dialogStore.openDialog({
    title: emailDialogTitle.value,
    description: emailDialogDescription.value,
    size: 'lg',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        id: 'invite-email-next',
        text: t('button-next'),
        role: 'primary',
        preventClose: true,
        handler: () => {
          handleEmailSubmit()
        },
      },
    ],
  })

  dialogStore.onDialogDismiss().then(() => {
    isEmailDialogOpen.value = false
    isInviting.value = false
    resetInviteForm()
  })
}

function showFullDetailsDialog() {
  isEmailDialogOpen.value = false
  isFullDetailsDialogOpen.value = true

  dialogStore.openDialog({
    title: t('invite-new-user-dialog-header'),
    description: t('invite-new-user-dialog-description'),
    size: 'lg',
    preventAccidentalClose: true,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        id: 'invite-full-send',
        text: t('send-invitation'),
        role: 'primary',
        preventClose: true,
        handler: () => {
          handleFullDetailsSubmit()
        },
      },
    ],
  })

  // Disable button initially since captcha won't be ready
  updateFullDetailsButton()

  dialogStore.onDialogDismiss().then(() => {
    isFullDetailsDialogOpen.value = false
    isInviting.value = false
    resetInviteForm()
  })
}

function updateEmailDialogButton(loading: boolean) {
  const buttons = dialogStore.dialogOptions?.buttons
  if (!buttons)
    return
  const submitButton = buttons.find(button => button.id === 'invite-email-next')
  if (!submitButton)
    return
  submitButton.disabled = loading
  submitButton.text = loading
    ? t('checking')
    : t('button-next')
}

function updateFullDetailsButton() {
  const buttons = dialogStore.dialogOptions?.buttons
  if (!buttons)
    return
  const submitButton = buttons.find(button => button.id === 'invite-full-send')
  if (!submitButton)
    return
  const captchaNotReady = shouldUseCaptcha.value && !inviteCaptchaToken.value
  submitButton.disabled = isInviting.value || captchaNotReady
  submitButton.text = isInviting.value
    ? t('sending-invitation')
    : t('send-invitation')
}

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(email.toLowerCase())
}

function resetInviteForm() {
  inviteEmail.value = ''
  inviteFirstName.value = ''
  inviteLastName.value = ''
  if (shouldUseCaptcha.value) {
    inviteCaptchaToken.value = ''
    inviteCaptchaElement.value?.reset()
  }
}

function completeInviteSuccess(payload: InviteSuccessPayload) {
  resetInviteForm()
  dialogStore.closeDialog()
  isEmailDialogOpen.value = false
  isFullDetailsDialogOpen.value = false
  emit('success', payload)
  const orgId = organizationStore.currentOrganization?.gid
  if (orgId) {
    sendEvent({
      channel: 'onboarding-v2',
      event: `onboarding-step-invite-teammate`,
      icon: '👥',
      org_id: orgId,
      tracking_version: 2,
      notify: false,
    }).catch()
  }
}

async function handleEmailSubmit() {
  if (isInviting.value)
    return

  const email = inviteEmail.value.trim().toLowerCase()

  if (!email) {
    toast.error(t('missing-email'))
    return
  }

  if (!validateEmail(email)) {
    toast.error(t('invalid-email'))
    return
  }

  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId) {
    toast.error(t('organization-not-found'))
    return
  }

  isInviting.value = true
  updateEmailDialogButton(true)

  try {
    let data: string | null = null
    let error: unknown = null

    const result = await supabase.rpc('invite_user_to_org_rbac', {
      email,
      org_id: orgId,
      role_name: existingUserInviteRole,
    })
    data = result.data
    error = result.error

    if (error) {
      console.error('Error inviting user:', error)
      toast.error(t('error-inviting-user'))
      return
    }

    if (!data) {
      toast.error(t('invitation-failed'))
      return
    }

    if (data === 'OK') {
      const notified = await notifyExistingUserInvite(supabase, email, orgId)
      if (!notified) {
        console.warn('Failed to send invite email notification, but invite was created')
        toast.warning(t('org-invite-email-notification-failed'))
      }
      toast.success(t('org-invited-user'))
      completeInviteSuccess({
        email,
        firstName: '',
        lastName: '',
      })
      return
    }

    if (data === 'NO_EMAIL') {
      // User doesn't exist, show full details dialog
      if (!captchaKey.value) {
        toast.error(t('captcha-not-available'))
        return
      }
      showFullDetailsDialog()
      return
    }

    if (data === 'ALREADY_INVITED') {
      toast.error(t('user-already-invited'))
    }
    else if (data === 'TOO_RECENT_INVITATION_CANCELATION') {
      toast.error(t('too-recent-invitation-cancelation'))
    }
    else if (data === 'CAN_NOT_INVITE_OWNER') {
      toast.error(t('cannot-invite-owner'))
    }
    else if (data === 'RBAC_NOT_ENABLED' || data === 'ROLE_NOT_FOUND') {
      toast.error(t('invitation-failed'))
    }
    else if (data === 'NO_RIGHTS') {
      toast.error(t('no-permission'))
    }
    else {
      toast.error(`${t('unexpected-invitation-response')}: ${data}`)
    }
  }
  finally {
    isInviting.value = false
    updateEmailDialogButton(false)
  }
}

async function handleFullDetailsSubmit() {
  if (isInviting.value)
    return

  const email = inviteEmail.value.trim().toLowerCase()
  const firstName = inviteFirstName.value.trim()
  const lastName = inviteLastName.value.trim()

  if (!firstName) {
    toast.error(t('first-name-required'))
    return
  }

  if (!lastName) {
    toast.error(t('last-name-required'))
    return
  }

  if (shouldUseCaptcha.value && !inviteCaptchaToken.value) {
    toast.error(t('captcha-required'))
    return
  }

  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId) {
    toast.error(t('organization-not-found'))
    return
  }

  isInviting.value = true

  try {
    const { error } = await invokeCapgoApi('private/invite_new_user_to_org', {
      body: {
        email,
        org_id: orgId,
        invite_type: newUserInviteRole,
        captcha_token: shouldUseCaptcha.value ? inviteCaptchaToken.value : undefined,
        first_name: firstName,
        last_name: lastName,
      },
    })

    if (error) {
      console.error('Invite new user failed', error)
      const errorMessage = await resolveInviteNewUserErrorMessage(error, t, {
        cancelledFallback: 'An invitation was cancelled recently. Please wait a bit longer.',
      })
      toast.error(errorMessage ?? t('invitation-failed'))
      return
    }

    toast.success(t('org-invited-user'))
    completeInviteSuccess({
      email,
      firstName,
      lastName,
    })
  }
  finally {
    isInviting.value = false
    if (shouldUseCaptcha.value)
      inviteCaptchaElement.value?.reset()
    inviteCaptchaToken.value = ''
  }
}

watch([isInviting, isFullDetailsDialogOpen, inviteCaptchaToken], ([_loading, open]) => {
  if (!open)
    return
  updateFullDetailsButton()
}, { immediate: true })

defineExpose({
  openDialog,
})
</script>

<template>
  <!-- Step 1: Email input dialog -->
  <Teleport v-if="dialogStore.showDialog && isEmailDialogOpen" to="#dialog-v2-content" defer>
    <form @submit.prevent="handleEmailSubmit">
      <div>
        <label for="invite-email" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
          {{ t('email') }}
        </label>
        <input
          id="invite-email"
          v-model="inviteEmail"
          type="email"
          autocomplete="email"
          class="block py-2 px-3 w-full text-sm rounded-md border border-gray-300 shadow-sm dark:text-gray-100 dark:border-gray-700 dark:bg-slate-900 focus:ring-muted-blue-500 focus:border-muted-blue-500"
          placeholder="teammate@email.com"
          required
        >
      </div>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
  </Teleport>

  <!-- Step 2: Full details dialog (name + captcha) -->
  <Teleport v-if="dialogStore.showDialog && isFullDetailsDialogOpen" to="#dialog-v2-content" defer>
    <form class="grid gap-4" @submit.prevent="handleFullDetailsSubmit">
      <!-- Email (not editable) -->
      <div>
        <label for="invite-email-readonly" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
          {{ t('email') }}
        </label>
        <input
          id="invite-email-readonly"
          v-model="inviteEmail"
          type="email"
          disabled
          class="block py-2 px-3 w-full text-sm rounded-md border border-gray-300 shadow-sm cursor-not-allowed bg-gray-100 dark:text-gray-100 dark:border-gray-700 dark:bg-gray-700"
        >
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label for="invite-first-name" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t('first-name') }}
          </label>
          <input
            id="invite-first-name"
            v-model="inviteFirstName"
            type="text"
            autocomplete="given-name"
            class="block py-2 px-3 w-full text-sm rounded-md border border-gray-300 shadow-sm dark:text-gray-100 dark:border-gray-700 dark:bg-slate-900 focus:ring-muted-blue-500 focus:border-muted-blue-500"
            placeholder="Jane"
            required
          >
        </div>
        <div>
          <label for="invite-last-name" class="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t('last-name') }}
          </label>
          <input
            id="invite-last-name"
            v-model="inviteLastName"
            type="text"
            autocomplete="family-name"
            class="block py-2 px-3 w-full text-sm rounded-md border border-gray-300 shadow-sm dark:text-gray-100 dark:border-gray-700 dark:bg-slate-900 focus:ring-muted-blue-500 focus:border-muted-blue-500"
            placeholder="Doe"
            required
          >
        </div>
      </div>
      <template v-if="shouldUseCaptcha">
        <div>
          <VueTurnstile
            id="invite-captcha"
            ref="inviteCaptchaElement"
            v-model="inviteCaptchaToken"
            size="flexible"
            :site-key="captchaKey!"
          />
        </div>
      </template>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        {{ t('invite-new-user-dialog-helper') }}
      </p>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
  </Teleport>
</template>
