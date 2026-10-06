<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { getSelectedLanguage } from '~/modules/i18n'
import { getInboxMessage, inboxContext, recordInboxEvent } from '~/services/inbox'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const route = useRoute()
const main = useMainStore()
const orgs = useOrganizationStore()
const dialog = useDialogV2Store()
const { t, locale } = useI18n()
const appId = computed(() => 'app' in route.params && typeof route.params.app === 'string' ? route.params.app : null)
const orgId = computed(() => appId.value ? orgs.getOrgByAppId(appId.value)?.gid ?? null : orgs.currentOrganization?.gid ?? null)
const scope = computed(() => [main.auth?.id, orgId.value, appId.value, route.path, locale.value].join('|'))
let timer: ReturnType<typeof setTimeout> | undefined
let poll: ReturnType<typeof setInterval> | undefined
let controller: AbortController | undefined
let stopped = false
const checked = new Map<string, number>()
const shown = new Set<string>()

function hasOtherDialog() {
  return dialog.showDialog || !!document.querySelector('[aria-modal="true"], .d-modal-open')
}

function closeForContextChange() {
  if (dialog.dialogOptions.id === 'inbox-message' && dialog.showDialog)
    void dialog.closeDialog(undefined, 'navigation')
}

async function check() {
  const key = scope.value
  if (stopped || !main.auth?.id || !orgId.value || hasOtherDialog() || document.visibilityState !== 'visible')
    return
  if (/^\/(?:login|register|onboarding|confirm-signup|sso-callback|forgot_password|delete_account)(?:\/|$)/.test(route.path))
    return
  if (Date.now() - (checked.get(key) ?? 0) < 60_000)
    return
  checked.set(key, Date.now())
  if (checked.size > 100)
    checked.delete(checked.keys().next().value!)
  controller?.abort()
  const request = new AbortController()
  controller = request
  const timeout = setTimeout(() => request.abort(), 5000)
  try {
    const context = inboxContext({
      locale: getSelectedLanguage(),
      org_id: orgId.value,
      app_id: appId.value,
      page: String(route.matched.at(-1)?.path ?? route.path),
    })
    const message = await getInboxMessage(context, request.signal)
    const messageKey = `${main.auth?.id}|${message?.id}`
    if (!message || stopped || request.signal.aborted || key !== scope.value || hasOtherDialog() || shown.has(messageKey) || document.visibilityState !== 'visible')
      return
    shown.add(messageKey)
    dialog.openDialog({
      id: 'inbox-message',
      embed: { ...message.presentation, url: message.embed_url, title: t('inbox-message') },
      onClose(reason) {
        const event = ['close_button', 'escape', 'backdrop'].includes(reason) ? 'dismissed' : reason === 'load_failed' ? 'failed' : 'abandoned'
        void recordInboxEvent(message, event, reason).catch(() => undefined)
      },
      onEmbedReady() {
        void recordInboxEvent(message, 'shown', 'ready').catch(() => undefined)
      },
    })
  }
  catch {
    // A background inbox lookup must never interrupt the current page.
  }
  finally {
    clearTimeout(timeout)
    if (controller === request)
      controller = undefined
  }
}

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(() => void check(), 2500)
}

watch(scope, () => {
  controller?.abort()
  closeForContextChange()
  schedule()
}, { immediate: true })
watch(() => dialog.showDialog, open => !open && schedule())
onMounted(() => {
  window.addEventListener('focus', schedule)
  document.addEventListener('visibilitychange', schedule)
  poll = setInterval(schedule, 5 * 60_000)
})
onBeforeUnmount(() => {
  stopped = true
  clearTimeout(timer)
  clearInterval(poll)
  controller?.abort()
  closeForContextChange()
  window.removeEventListener('focus', schedule)
  document.removeEventListener('visibilitychange', schedule)
})
</script>

<template>
  <span hidden />
</template>
