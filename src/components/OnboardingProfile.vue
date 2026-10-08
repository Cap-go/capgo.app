<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'

defineProps<{ disabled?: boolean }>()

const main = useMainStore()
const supabase = useSupabase()
const { t } = useI18n()
const firstName = ref(main.user?.first_name ?? '')
const lastName = ref(main.user?.last_name ?? '')
const needsProfileName = computed(() => !main.user?.first_name?.trim() || !main.user?.last_name?.trim())
const isValid = computed(() => !!main.user?.id && !!firstName.value.trim() && !!lastName.value.trim())

watch(() => main.user, (user) => {
  if (!firstName.value.trim())
    firstName.value = user?.first_name ?? ''
  if (!lastName.value.trim())
    lastName.value = user?.last_name ?? ''
})

async function save() {
  if (!isValid.value || !main.user)
    return false
  if (!needsProfileName.value)
    return true

  try {
    const userId = main.user.id
    const { data, error } = await supabase
      .from('users')
      .update({ first_name: firstName.value.trim(), last_name: lastName.value.trim() })
      .eq('id', userId)
      .select('id, first_name, last_name')
      .single()

    if (error || !data || main.user?.id !== userId)
      throw error ?? new Error('onboarding_profile_save_failed')

    main.user = { ...main.user, ...data }
    return true
  }
  catch (error) {
    console.error('Failed to save profile name during onboarding', error)
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
        v-model="firstName"
        type="text"
        autocomplete="given-name"
        required
        :disabled="disabled"
        data-test="onboarding-first-name"
        class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 dark:border-white/20 dark:bg-slate-950/90 dark:text-white"
      >
    </div>
    <div>
      <label for="onboarding-last-name" class="text-sm font-medium text-slate-800 dark:text-slate-200">
        {{ t('last-name') }}
      </label>
      <input
        id="onboarding-last-name"
        v-model="lastName"
        type="text"
        autocomplete="family-name"
        required
        :disabled="disabled"
        data-test="onboarding-last-name"
        class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 dark:border-white/20 dark:bg-slate-950/90 dark:text-white"
      >
    </div>
  </div>
</template>
