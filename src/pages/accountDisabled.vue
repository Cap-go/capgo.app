<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { authGhostButtonClass, authPrimaryButtonClass, authSecondaryButtonClass } from '~/components/auth/pageStyles'
import { useSupabase } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const main = useMainStore()
const supabase = useSupabase()

async function handleLogout() {
  await main.logout()
  router.replace('/login')
}

const deletionDate = ref<Date | null>(null)
const currentTime = ref(new Date())
const loading = ref(true)
const error = ref<string | null>(null)
const isRestoring = ref(false)
let intervalId: NodeJS.Timeout | null = null

const restoreTarget = computed(() => {
  const target = typeof route.query.to === 'string' ? route.query.to : ''
  if (target.startsWith('/') && target !== '/accountDisabled')
    return target
  return '/dashboard'
})

async function handleRestore() {
  if (isRestoring.value)
    return

  isRestoring.value = true

  try {
    const { error: restoreError } = await supabase.rpc('restore_deleted_account')
    if (restoreError) {
      console.error('Error restoring deleted account:', restoreError)
      if (restoreError.message?.includes('reauth_required')) {
        toast.error(t('account-restore-reauth-required'))
      }
      else {
        toast.error(t('account-restore-failed'))
      }
      return
    }

    toast.success(t('account-restored-successfully'))
    await router.replace(restoreTarget.value)
  }
  catch (restoreError) {
    console.error('Error restoring deleted account:', restoreError)
    toast.error(t('account-restore-failed'))
  }
  finally {
    isRestoring.value = false
  }
}

// Use i18n component interpolation in the template; no HTML parsing here

// Fetch removal date and start timer
onMounted(async () => {
  try {
    if (main.auth?.id) {
      const { data: removalDateStr, error: dateError } = await supabase
        .rpc('get_account_removal_date')

      if (dateError) {
        console.error('Error fetching removal date:', dateError)
        error.value = t('error-loading-deletion-date')
      }
      else if (removalDateStr) {
        deletionDate.value = new Date(removalDateStr)
      }
    }
    else {
      error.value = t('error-no-user-id')
    }
  }
  catch (err) {
    console.error('Error fetching removal date:', err)
    error.value = t('error-loading-deletion-date')
  }
  finally {
    loading.value = false
  }

  // Update current time every second
  intervalId = setInterval(() => {
    currentTime.value = new Date()
  }, 1000)
})

onUnmounted(() => {
  if (intervalId) {
    clearInterval(intervalId)
  }
})

// Calculate time remaining
const timeRemaining = computed(() => {
  if (loading.value) {
    return t('loading')
  }

  if (error.value || !deletionDate.value) {
    return error.value || t('error')
  }

  const diff = deletionDate.value.getTime() - currentTime.value.getTime()

  if (diff <= 0) {
    return t('account-deletion-very-soon')
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((diff % (1000 * 60)) / 1000)

  // Always show seconds
  if (days > 0) {
    return `${days} days, ${hours} hours, ${minutes} minutes, ${seconds} seconds`
  }
  else if (hours > 0) {
    return `${hours} hours, ${minutes} minutes, ${seconds} seconds`
  }
  else if (minutes > 0) {
    return `${minutes} minutes, ${seconds} seconds`
  }
  else {
    return `${seconds} seconds`
  }
})
</script>

<template>
  <AuthPageShell
    card-width-class="max-w-md"
    :card-kicker="t('account-deletion-requested')"
    :card-title="t('account-deletion-requested')"
  >
    <div class="space-y-5 text-center text-slate-500 dark:text-slate-300">
      <p class="text-sm leading-6">
        {{ t('account-deletion-restore') }}
      </p>
      <i18n-t keypath="account-deletion-support" tag="p" class="text-sm leading-6">
        <template #link>
          <a
            href="https://support.capgo.app/"
            target="_blank"
            rel="noopener noreferrer"
            class="font-semibold text-[rgb(255,114,17)] transition-colors duration-200 hover:text-[rgb(235,94,0)]"
          >Capgo support</a>
        </template>
      </i18n-t>

      <div class="rounded-3xl border border-rose-200 bg-rose-50 px-5 py-5 dark:border-rose-900/70 dark:bg-rose-950/30">
        <p class="text-sm font-semibold tracking-[0.12em] uppercase text-rose-700 dark:text-rose-200">
          {{ timeRemaining === t('account-deletion-very-soon') ? t('account-deletion-timer') : t('account-deletion-timer-in') }}
        </p>
        <p class="mt-3 text-3xl font-semibold text-rose-900 dark:text-rose-100">
          {{ timeRemaining }}
        </p>
      </div>

      <button type="button" :class="authPrimaryButtonClass" :disabled="isRestoring" :aria-busy="isRestoring ? 'true' : 'false'" @click="handleRestore">
        {{ isRestoring ? t('restoring-account') : t('restore-account') }}
      </button>

      <button type="button" :class="authSecondaryButtonClass" @click="handleLogout">
        {{ t('sign-out') }}
      </button>
    </div>

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
  </AuthPageShell>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
