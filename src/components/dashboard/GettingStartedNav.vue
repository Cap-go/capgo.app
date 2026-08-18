<script setup lang="ts">
import type { OrganizationApp } from '~/stores/organization'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconX from '~icons/lucide/x'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import {
  parseAppOnboardingLedger,
  shouldShowGettingStartedNav,
  withGettingStartedDismissed,
  withoutGettingStartedDismissed,
} from '~/utils/appOnboardingProgress'
import { isStoreReleaseValidated } from '~/utils/gettingStartedDismiss'

const props = withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const userId = computed(() => main.user?.id ?? main.auth?.id ?? '')

const apps = computed(() => {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !userId.value)
    return [] as OrganizationApp[]

  return organizationStore.getAppsByOrgId(orgId).filter((app) => {
    return shouldShowGettingStartedNav(parseAppOnboardingLedger(app.onboarding), {
      storeReleaseValidated: isStoreReleaseValidated(userId.value, app.app_id),
    })
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

async function persistDismiss(app: OrganizationApp) {
  const { data, error } = await supabase.rpc('dismiss_getting_started', {
    p_app_id: app.app_id,
  })
  const current = organizationStore.getAppByAppId(app.app_id)?.onboarding ?? app.onboarding ?? {}
  if (error) {
    console.error('Failed to dismiss getting started', error)
    organizationStore.updateAppOnboarding(app.app_id, withoutGettingStartedDismissed(current))
    return
  }
  organizationStore.updateAppOnboarding(
    app.app_id,
    withGettingStartedDismissed(current, parseAppOnboardingLedger(data).getting_started_dismissed_at ?? undefined),
  )
}

function dismiss(app: OrganizationApp, event: Event) {
  event.preventDefault()
  event.stopPropagation()
  organizationStore.updateAppOnboarding(app.app_id, withGettingStartedDismissed(app.onboarding))
  void persistDismiss(app)
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
  <div v-if="apps.length" data-test="getting-started-nav" class="pt-2">
    <ul class="max-h-56 space-y-1 overflow-y-auto">
      <li v-for="app in apps" :key="app.app_id">
        <div
          class="flex items-center rounded-lg transition-colors duration-150"
          :class="isActive(app.app_id) ? 'bg-azure-500/20' : 'bg-azure-500/10 hover:bg-azure-500/20'"
        >
          <router-link
            class="d-btn d-btn-ghost flex min-h-11 h-auto min-w-0 flex-1 items-center justify-start border-none bg-transparent p-0 shadow-none hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-azure-500 focus:ring-offset-2 focus:ring-offset-slate-800"
            :to="gettingStartedPath(app.app_id)"
            :aria-current="isActive(app.app_id) ? 'page' : undefined"
            :aria-label="`${t('getting-started')} — ${appLabel(app)}`"
            :title="`${t('getting-started')} — ${appLabel(app)}`"
            data-test="getting-started-nav-link"
          >
            <span class="flex w-12 h-11 shrink-0 items-center justify-center">
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
            </span>
            <span class="min-w-0 truncate pr-2 text-sm font-medium text-azure-100 whitespace-nowrap">
              {{ t('getting-started') }}
            </span>
          </router-link>
          <button
            v-if="!props.compact"
            type="button"
            class="flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors duration-150 hover:bg-slate-700/80 hover:text-white focus:outline-none focus:ring-2 focus:ring-azure-500 focus:ring-offset-2 focus:ring-offset-slate-800"
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
