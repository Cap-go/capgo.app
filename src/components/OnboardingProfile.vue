<script setup lang="ts">
import type { Json } from '~/types/supabase.types'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { setUser } from '~/services/posthog'
import { getLocalConfig, useSupabase } from '~/services/supabase'
import { replaceUserOnboardingWithRetry, serializeUserOnboardingWrite } from '~/services/userOnboardingWriteQueue'
import { useMainStore } from '~/stores/main'
import { hasProfileOnboarding } from '~/utils/onboardingABTests'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{
  fieldInput: [field: 'first_name' | 'last_name', value: string]
  saved: []
  saveFailed: []
}>()

const main = useMainStore()
const supabase = useSupabase()
const { t } = useI18n()
const firstName = ref(main.user?.first_name ?? '')
const lastName = ref(main.user?.last_name ?? '')
const needsProfileName = computed(() => hasProfileOnboarding(main.user?.onboarding) && (!main.user?.first_name?.trim() || !main.user?.last_name?.trim()))
const isValid = computed(() => !!main.user?.id && (!needsProfileName.value || (!!firstName.value.trim() && !!lastName.value.trim())))
let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftUserId = main.user?.id
let draftAuthGeneration = main.authGeneration
const edited = { first_name: false, last_name: false }

function onboardingObject(value: Json): { [key: string]: Json | undefined } {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

watch(() => [main.user, main.authGeneration] as const, ([user, authGeneration]) => {
  if (draftUserId !== user?.id || draftAuthGeneration !== authGeneration) {
    clearTimeout(draftTimer)
    draftTimer = undefined
    edited.first_name = edited.last_name = false
    draftUserId = user?.id
    draftAuthGeneration = authGeneration
  }
  const draft = onboardingObject(onboardingObject(user?.onboarding ?? {}).profile_draft ?? {})
  if (!edited.first_name)
    firstName.value = typeof draft.first_name === 'string' ? draft.first_name : user?.first_name ?? ''
  if (!edited.last_name)
    lastName.value = typeof draft.last_name === 'string' ? draft.last_name : user?.last_name ?? ''
}, { immediate: true })

async function persistDraft() {
  const userId = draftUserId
  const authGeneration = draftAuthGeneration
  if (!userId || main.user?.id !== userId || main.authGeneration !== authGeneration || !needsProfileName.value)
    return
  const profileDraft = { first_name: firstName.value, last_name: lastName.value }
  const isCurrentUser = () => main.user?.id === userId && main.authGeneration === authGeneration
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

function fieldInput(field: 'first_name' | 'last_name', value: string) {
  edited[field] = true
  if (field === 'first_name')
    firstName.value = value
  else
    lastName.value = value
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

async function save() {
  if (!isValid.value || !main.user)
    return false
  if (!needsProfileName.value)
    return true

  try {
    const userId = main.user.id
    const authGeneration = main.authGeneration
    const { data, error } = await supabase
      .from('users')
      .update({ first_name: firstName.value.trim(), last_name: lastName.value.trim() })
      .eq('id', userId)
      .select('id, first_name, last_name')
      .single()

    if (error || !data || main.user?.id !== userId || main.authGeneration !== authGeneration)
      throw error ?? new Error('onboarding_profile_save_failed')

    main.user = { ...main.user, ...data }
    try {
      setUser(userId, {
        email: main.user.email,
        first_name: data.first_name ?? undefined,
        last_name: data.last_name ?? undefined,
        nickname: [data.first_name, data.last_name].join(' '),
        avatar: main.user.image_url ?? undefined,
      }, getLocalConfig().supaHost)
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

defineExpose({ isValid, save })
</script>

<template>
  <div v-if="needsProfileName" class="grid gap-4 sm:grid-cols-2">
    <div>
      <label for="onboarding-first-name" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('first-name') }}
      </label>
      <input
        id="onboarding-first-name"
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
      <label for="onboarding-last-name" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('last-name') }}
      </label>
      <input
        id="onboarding-last-name"
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
  </div>
</template>
