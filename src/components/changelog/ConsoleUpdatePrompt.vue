<script setup lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ChangelogDigestCard from '~/components/changelog/ChangelogDigestCard.vue'
import {
  changelogLocation,
  cleanVersion,
  getLastSeenConsoleVersion,
  isNewerVersion,
  setLastSeenConsoleVersion,
} from '~/services/changelog'
import { useDialogV2Store } from '~/stores/dialogv2'

// Two moments, one source of truth (the console GitHub releases):
// 1. a newer console is deployed while this tab runs → modal with an AI summary and "Reload".
// 2. the user opens a console newer than the last one they saw → a quiet "what's new" toast.
const CHECK_INTERVAL_MS = 10 * 60 * 1000
const DISMISSED_KEY = 'capgo_console_update_dismissed'
const DIALOG_ID = 'console-update-available'

const { t } = useI18n()
const router = useRouter()
const dialogStore = useDialogV2Store()
const visibility = useDocumentVisibility()
const runningVersion = cleanVersion(import.meta.env.VITE_APP_VERSION as string | undefined)
const availableVersion = ref<string | null>(null)

function dismissedVersion() {
  try {
    return sessionStorage.getItem(DISMISSED_KEY)
  }
  catch {
    return null
  }
}

function rememberDismissed(version: string) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, version)
  }
  catch {}
}

async function fetchDeployedVersion(): Promise<string | null> {
  try {
    // Emitted by the build next to index.html and served with no-store.
    const response = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok)
      return null
    const json = await response.json() as { version?: string }
    return cleanVersion(json.version)
  }
  catch {
    return null
  }
}

const pendingVersion = ref<string | null>(null)

async function openUpdateDialog(version: string) {
  // DialogV2 is a single shared dialog: never replace one the user is answering; show ours once it closes.
  if (dialogStore.showDialog) {
    pendingVersion.value = version
    return
  }
  pendingVersion.value = null
  availableVersion.value = version
  dialogStore.openDialog({
    id: DIALOG_ID,
    title: t('console-update-title', { version }),
    description: t('console-update-description', { current: runningVersion }),
    size: 'lg',
    buttons: [
      { text: t('console-update-later'), role: 'cancel' },
      { text: t('changelog-see-full'), role: 'secondary', id: 'console-update-changelog' },
      { text: t('console-update-reload'), role: 'primary', id: 'console-update-reload' },
    ],
  })
  await dialogStore.onDialogDismiss()
  // lastButtonRole holds the button id when one is set.
  const choice = dialogStore.lastButtonRole
  if (choice === 'console-update-reload') {
    globalThis.location.reload()
    return
  }
  rememberDismissed(version)
  if (choice === 'console-update-changelog')
    await router.push(changelogLocation('console', { since: runningVersion }))
}

async function checkForUpdate() {
  if (!runningVersion)
    return
  const deployed = await fetchDeployedVersion()
  if (!deployed || !isNewerVersion(deployed, runningVersion) || dismissedVersion() === deployed)
    return
  await openUpdateDialog(deployed)
}

function announceWhatsNew() {
  if (!runningVersion)
    return
  const lastSeen = cleanVersion(getLastSeenConsoleVersion())
  setLastSeenConsoleVersion(runningVersion)
  // First visit on this browser: nothing to compare against, stay quiet.
  if (!lastSeen || !isNewerVersion(runningVersion, lastSeen))
    return
  toast(t('console-updated-toast', { version: runningVersion }), {
    duration: 10_000,
    action: {
      label: t('changelog-whats-new'),
      onClick: () => {
        void router.push(changelogLocation('console', { since: lastSeen }))
      },
    },
  })
}

watch(() => dialogStore.showDialog, (open) => {
  const version = pendingVersion.value
  if (!open && version)
    setTimeout(() => void openUpdateDialog(version), 400)
})

onMounted(() => {
  announceWhatsNew()
  void checkForUpdate()
})
useIntervalFn(() => void checkForUpdate(), CHECK_INTERVAL_MS)
watch(visibility, (state) => {
  if (state === 'visible')
    void checkForUpdate()
})
</script>

<template>
  <Teleport
    v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === DIALOG_ID && availableVersion && runningVersion"
    defer
    to="#dialog-v2-content"
  >
    <ChangelogDigestCard
      product="console"
      :from-version="runningVersion"
      :to-version="availableVersion"
      compact
    />
  </Teleport>
</template>
