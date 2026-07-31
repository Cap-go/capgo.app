<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { logAsUser } from '~/services/logAs'
import { isSpoofed, unspoofUser } from '~/services/supabase'
import { openSupport } from '~/services/support'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const main = useMainStore()
const dialogStore = useDialogV2Store()
const isMobile = ref(Capacitor.isNativePlatform())
const acronym = computed(() => {
  let res = 'MD'
  if (main.user?.first_name && main.user?.last_name)
    res = main.user?.first_name[0] + main.user?.last_name[0]
  else if (main.user?.first_name)
    res = main.user?.first_name[0]
  else if (main.user?.last_name)
    res = main.user?.last_name[0]
  return res.toUpperCase()
})
const isLoading = ref(false)
const spoofed = ref(isSpoofed())
const logAsInput = ref('')

async function openLogAsDialog() {
  let identifier = ''
  logAsInput.value = ''

  dialogStore.openDialog({
    title: t('log-as'),
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('log-as'),
        handler: () => {
          identifier = logAsInput.value
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()

  if (identifier) {
    isLoading.value = true
    try {
      await logAsUser(identifier, router)
    }
    finally {
      isLoading.value = false
    }
  }
}

async function resetSpoofedUser() {
  isLoading.value = true
  try {
    const restored = await unspoofUser()
    spoofed.value = isSpoofed()

    if (!restored) {
      toast.error(t('spoof-session-cleared'))
      return
    }

    toast.success(t('spoof-stopped-reload'))
    setTimeout(() => {
      router.replace('/dashboard').then(() => {
        globalThis.location.reload()
      })
    }, 1000)
  }
  finally {
    isLoading.value = false
  }
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
          main.logout().then(() => router.replace('/login'))
        },
      },
    ],
  })
  await dialogStore.onDialogDismiss()
}
</script>

<template>
  <div>
    <div class="relative text-gray-300">
      <div class="flex flex-col p-4 space-y-2">
        <div class="flex items-center mb-4">
          <img v-if="main.user?.image_url" class="mr-3 w-10 h-10 d-mask d-mask-squircle" :src="main.user?.image_url" alt="User" width="32" height="32">
          <div v-else class="p-2 mr-3 bg-gray-700 d-mask d-mask-squircle">
            <span class="font-medium">
              {{ acronym }}
            </span>
          </div>
          <div class="min-w-0">
            <p class="font-medium truncate">
              {{ `${main.user?.first_name} ${main.user?.last_name}` }}
            </p>
            <p class="text-sm text-gray-400 truncate">
              {{ main.user?.email }}
            </p>
          </div>
        </div>
        <router-link to="/settings/account" class="block py-2 px-3 rounded-lg hover:bg-slate-700/50">
          {{ t('settings') }}
        </router-link>
        <router-link v-if="isMobile" to="/app/modules" class="block py-2 px-3 rounded-lg hover:bg-slate-700/50">
          {{ t('module-heading') }}
        </router-link>
        <router-link v-if="isMobile" to="/app/modules_test" class="block py-2 px-3 rounded-lg hover:bg-slate-700/50">
          {{ t('module-heading') }} {{ t('tests') }}
        </router-link>
        <div class="block py-2 px-3 rounded-lg cursor-pointer hover:bg-slate-700/50" @click="openSupport">
          {{ t('support') }}
        </div>
        <div v-if="main.isAdmin && !spoofed" class="block py-2 px-3 rounded-lg cursor-pointer hover:bg-slate-700/50" :class="{ 'opacity-50 cursor-not-allowed': isLoading }" @click="openLogAsDialog">
          <span v-if="!isLoading">{{ t('log-as') }}</span>
          <span v-else class="flex items-center">
            <Spinner size="w-4 h-4" class="mr-2" />
            {{ t('loading') }}
          </span>
        </div>
        <div v-if="spoofed" class="block py-2 px-3 rounded-lg cursor-pointer hover:bg-slate-700/50" :class="{ 'opacity-50 cursor-not-allowed': isLoading }" @click="resetSpoofedUser">
          {{ t('reset-spoofed-user') }}
        </div>
        <div class="block py-2 px-3 rounded-lg cursor-pointer hover:bg-slate-700/50" @click="logOut">
          {{ t('sign-out') }}
        </div>
      </div>
    </div>

    <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('log-as')" to="#dialog-v2-content" defer>
      <div class="w-full">
        <label for="log-as-input" class="sr-only">{{ t('user-email-or-org-id') }}</label>
        <input
          id="log-as-input"
          v-model="logAsInput"
          type="text"
          :placeholder="t('user-email-or-org-id')"
          :aria-label="t('user-email-or-org-id')"
          class="p-3 w-full rounded-lg border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600"
          @keydown.enter="$event.preventDefault()"
        >
      </div>
    </teleport>
  </div>
</template>
