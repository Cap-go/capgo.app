<script setup lang="ts">
import type { OrganizationApp } from '~/stores/organization'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconX from '~icons/lucide/x'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import {
  parseAppOnboardingLedger,
  shouldShowGettingStartedNav,
} from '~/utils/appOnboardingProgress'
import {
  dismissGettingStarted,
  isGettingStartedDismissed,
} from '~/utils/gettingStartedDismiss'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const dismissedTick = ref(0)

const userId = computed(() => main.user?.id ?? main.auth?.id ?? '')

const apps = computed(() => {
  void dismissedTick.value
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !userId.value)
    return [] as OrganizationApp[]

  return organizationStore.getAppsByOrgId(orgId).filter((app) => {
    if (isGettingStartedDismissed(userId.value, app.app_id))
      return false
    return shouldShowGettingStartedNav(parseAppOnboardingLedger(app.onboarding))
  })
})

function appLabel(app: OrganizationApp) {
  return app.name || app.app_id
}

function acronym(name: string) {
  const trimmed = name.trim()
  if (!trimmed)
    return '?'
  const parts = trimmed.split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : (parts[0]?.[1] ?? '')
  return (first + second).toUpperCase()
}

function gettingStartedPath(appId: string) {
  return `/app/${encodeURIComponent(appId)}/getting-started`
}

function isActive(appId: string) {
  return route.path === gettingStartedPath(appId)
}

function dismiss(app: OrganizationApp, event: Event) {
  event.preventDefault()
  event.stopPropagation()
  if (!userId.value)
    return
  dismissGettingStarted(userId.value, app.app_id)
  dismissedTick.value += 1
  if (isActive(app.app_id))
    void router.push(`/app/${encodeURIComponent(app.app_id)}`)
}

watch(() => organizationStore.currentOrganization?.gid, async (orgId) => {
  if (!orgId)
    return
  await organizationStore.awaitInitialLoad()
  void organizationStore.refreshAppsOnboarding(orgId)
}, { immediate: true })
</script>

<template>
  <div v-if="apps.length" class="px-3 pt-3 lg:px-6" data-test="getting-started-nav">
    <ul class="max-h-56 space-y-1 overflow-y-auto">
      <li v-for="app in apps" :key="app.app_id">
        <div
          class="flex items-center gap-1 rounded-lg transition duration-150"
          :class="isActive(app.app_id) ? 'bg-azure-500/20' : 'bg-azure-500/10 hover:bg-azure-500/20'"
        >
          <router-link
            class="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-azure-500 focus:ring-offset-2 focus:ring-offset-slate-800"
            :to="gettingStartedPath(app.app_id)"
            :aria-current="isActive(app.app_id) ? 'page' : undefined"
            :aria-label="`${t('getting-started')} — ${appLabel(app)}`"
            data-test="getting-started-nav-link"
          >
            <img
              v-if="app.icon_url"
              :src="app.icon_url"
              :alt="`${appLabel(app)} icon`"
              class="size-6 shrink-0 rounded-sm object-cover d-mask d-mask-squircle"
              width="24"
              height="24"
            >
            <span
              v-else-if="app.icon_url_loading"
              class="flex size-6 shrink-0 items-center justify-center rounded-sm bg-slate-700 d-mask d-mask-squircle"
            >
              <span class="size-3 rounded-full border-2 border-azure-400 border-t-transparent animate-spin" />
              <span class="sr-only">{{ t('loading') }}</span>
            </span>
            <span
              v-else
              class="flex size-6 shrink-0 items-center justify-center rounded-sm bg-slate-700 text-[10px] font-semibold text-slate-200 d-mask d-mask-squircle"
              aria-hidden="true"
            >
              {{ acronym(appLabel(app)) }}
            </span>
            <span class="min-w-0 truncate text-sm font-medium text-azure-100">
              {{ t('getting-started') }}
            </span>
          </router-link>
          <button
            type="button"
            class="flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition duration-150 hover:bg-slate-700/80 hover:text-white focus:outline-none focus:ring-2 focus:ring-azure-500 focus:ring-offset-2 focus:ring-offset-slate-800"
            :aria-label="`${t('getting-started-dismiss')} — ${appLabel(app)}`"
            data-test="getting-started-nav-dismiss"
            @click="dismiss(app, $event)"
          >
            <IconX class="size-4" />
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>
