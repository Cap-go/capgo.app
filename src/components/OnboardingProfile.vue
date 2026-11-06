<script setup lang="ts">
import type { Json } from '~/types/database.types'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { getLocalConfig, useConsole } from '~/services/console'
import { setUser } from '~/services/posthog'
import { replaceUserOnboardingWithRetry, serializeUserOnboardingWrite } from '~/services/userOnboardingWriteQueue'
import { useMainStore } from '~/stores/main'
import { readOnboardingCompanyName } from '~/utils/onboardingProfile'

const props = defineProps<{ disabled?: boolean, initial?: boolean }>()
const emit = defineEmits<{
  fieldInput: [field: 'first_name' | 'last_name' | 'company_name', value: string]
  saved: []
  saveFailed: []
}>()

const main = useMainStore()
const capgo = useConsole()
const { t } = useI18n()
const inputId = useId()
const firstName = ref(main.user?.first_name ?? '')
const lastName = ref(main.user?.last_name ?? '')
const companyName = ref(readOnboardingCompanyName(main.user?.onboarding))
const needsProfileName = computed(() => props.initial || !main.user?.first_name?.trim() || !main.user?.last_name?.trim())
const isValid = computed(() => !!main.user?.id
  && (!needsProfileName.value || (!!firstName.value.trim() && !!lastName.value.trim()))
  && (!props.initial || (companyName.value.trim().length >= 3 && companyName.value.trim().length <= 80)))
let draftGeneration = 0
let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftUserId = main.user?.id
let draftAuthGeneration = main.authGeneration
const edited = { first_name: false, last_name: false, company_name: false }

function onboardingObject(value: Json): { [key: string]: Json | undefined } {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

watch(() => [main.user, main.authGeneration] as const, ([user, authGeneration]) => {
  if (draftUserId !== user?.id || draftAuthGeneration !== authGeneration) {
    clearTimeout(draftTimer)
    draftTimer = undefined
    edited.first_name = edited.last_name = edited.company_name = false
    draftUserId = user?.id
    draftAuthGeneration = authGeneration
  }
  const draft = onboardingObject(onboardingObject(user?.onboarding ?? {}).profile_draft ?? {})
  if (!edited.first_name)
    firstName.value = typeof draft.first_name === 'string' ? draft.first_name : user?.first_name ?? ''
  if (!edited.last_name)
    lastName.value = typeof draft.last_name === 'string' ? draft.last_name : user?.last_name ?? ''
  if (!edited.company_name)
    companyName.value = typeof draft.company_name === 'string' ? draft.company_name : readOnboardingCompanyName(user?.onboarding)
}, { immediate: true })

async function persistDraft() {
  const userId = draftUserId
  const authGeneration = draftAuthGeneration
  if (!userId || main.user?.id !== userId || main.authGeneration !== authGeneration || !needsProfileName.value)
    return
  const generation = draftGeneration
  const profileDraft = {
    first_name: firstName.value,
    last_name: lastName.value,
    ...(props.initial ? { company_name: companyName.value } : {}),
  }
  const isCurrentUser = () => generation === draftGeneration && main.user?.id === userId && main.authGeneration === authGeneration
  try {
    await serializeUserOnboardingWrite(userId, async () => {
      if (!isCurrentUser() || !needsProfileName.value)
        return
      const result = await replaceUserOnboardingWithRetry(
        userId,
        main.user!.onboarding,
        current => ({ ...onboardingObject(current), profile_draft: profileDraft }),
        () => isCurrentUser() && needsProfileName.value,
      )
      if (result.status === 'persisted' && isCurrentUser())
        main.user = { ...main.user!, onboarding: result.onboarding }
      if (result.status === 'error')
        throw result.error
      if (result.status === 'conflict')
        throw new Error('onboarding_profile_draft_conflict')
    })
  }
  catch {
    console.warn('Cannot persist onboarding profile draft')
  }
}

function fieldInput(field: 'first_name' | 'last_name' | 'company_name', value: string) {
  edited[field] = true
  if (field === 'first_name')
    firstName.value = value
  else if (field === 'last_name')
    lastName.value = value
  else
    companyName.value = value
  emit('fieldInput', field, value)
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    draftTimer = undefined
    void persistDraft()
  }, 500)
}

onBeforeUnmount(() => {
  if (draftTimer !== undefined) {
    clearTimeout(draftTimer)
    void persistDraft()
  }
})

async function resetDraft(savedCompanyName?: string) {
  draftGeneration++
  clearTimeout(draftTimer)
  draftTimer = undefined
  edited.first_name = edited.last_name = edited.company_name = false
  firstName.value = main.user?.first_name ?? ''
  lastName.value = main.user?.last_name ?? ''
  companyName.value = savedCompanyName ?? readOnboardingCompanyName(main.user?.onboarding)
  const userId = main.user?.id
  const authGeneration = main.authGeneration
  if (!userId)
    return false
  try {
    return await serializeUserOnboardingWrite(userId, async () => {
      const isCurrentUser = () => main.user?.id === userId && main.authGeneration === authGeneration
      if (!isCurrentUser())
        return false
      const result = await replaceUserOnboardingWithRetry(userId, main.user!.onboarding, (current) => {
        const onboarding = { ...onboardingObject(current) }
        delete onboarding.profile_draft
        delete onboarding.profile_completed_at
        if (savedCompanyName !== undefined)
          onboarding.org_name = savedCompanyName
        return onboarding
      }, isCurrentUser)
      if (result.status !== 'persisted' || !isCurrentUser())
        return false
      main.user = { ...main.user!, onboarding: result.onboarding }
      return true
    })
  }
  catch (error) {
    console.warn('Cannot reset onboarding profile draft', error)
    return false
  }
}

async function save() {
  if (!isValid.value || !main.user)
    return false
  if (!needsProfileName.value)
    return true

  try {
    const userId = main.user.id
    const authGeneration = main.authGeneration
    const { data, error } = await capgo
      .from('users')
      .update({ first_name: firstName.value.trim(), last_name: lastName.value.trim() })
      .eq('id', userId)
      .select('id, first_name, last_name')
      .single()

    if (error || !data || main.user?.id !== userId || main.authGeneration !== authGeneration)
      throw error ?? new Error('onboarding_profile_save_failed')

    clearTimeout(draftTimer)
    draftTimer = undefined
    draftGeneration++
    main.user = { ...main.user, ...data }
    // A saved profile has no unfinished draft. Use the same queue as wizard writes.
    if (!await resetDraft(props.initial ? companyName.value.trim() : undefined))
      throw new Error('onboarding_profile_draft_reset_failed')
    try {
      setUser(userId, {
        email: main.user.email,
        first_name: data.first_name ?? undefined,
        last_name: data.last_name ?? undefined,
        nickname: [data.first_name, data.last_name].join(' '),
        avatar: main.user.image_url ?? undefined,
      }, getLocalConfig().apiHost)
    }
    catch {
      console.warn('Cannot update onboarding profile analytics')
    }
    emit('saved')
    return true
  }
  catch (error) {
    console.error('Failed to save profile name during onboarding', error)
    emit('saveFailed')
    toast.error(t('account-error'))
    return false
  }
}

defineExpose({ isValid, resetDraft, save })
</script>

<template>
  <div v-if="needsProfileName" class="grid gap-4 sm:grid-cols-2">
    <div>
      <label :for="`${inputId}-first-name`" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('first-name') }}
      </label>
      <input
        :id="`${inputId}-first-name`"
        :value="firstName"
        type="text"
        autocomplete="given-name"
        required
        :disabled="disabled"
        data-test="onboarding-first-name"
        class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 dark:border-white/20 dark:bg-slate-950/90 dark:text-white"
        @input="fieldInput('first_name', ($event.target as HTMLInputElement).value)"
      >
    </div>
    <div>
      <label :for="`${inputId}-last-name`" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('last-name') }}
      </label>
      <input
        :id="`${inputId}-last-name`"
        :value="lastName"
        type="text"
        autocomplete="family-name"
        required
        :disabled="disabled"
        data-test="onboarding-last-name"
        class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 dark:border-white/20 dark:bg-slate-950/90 dark:text-white"
        @input="fieldInput('last_name', ($event.target as HTMLInputElement).value)"
      >
    </div>
    <div v-if="initial" class="sm:col-span-2">
      <label :for="`${inputId}-company-name`" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('company-name') }}
      </label>
      <input
        :id="`${inputId}-company-name`"
        :value="companyName"
        name="organization"
        type="text"
        autocomplete="organization"
        minlength="3"
        maxlength="80"
        required
        :disabled="disabled"
        data-test="onboarding-company-name"
        class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 dark:border-white/20 dark:bg-slate-950/90 dark:text-white"
        @input="fieldInput('company_name', ($event.target as HTMLInputElement).value)"
      >
    </div>
  </div>
</template>
