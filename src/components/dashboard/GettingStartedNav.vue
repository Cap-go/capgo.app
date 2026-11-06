<script setup lang="ts">
import type { OrganizationApp } from '~/stores/organization'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconX from '~icons/lucide/x'
import { useConsole } from '~/services/console'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import {
  parseAppOnboardingLedger,
  shouldShowGettingStartedNav,
  withGettingStartedDismissed,
  withoutGettingStartedDismissed,
} from '~/utils/appOnboardingProgress'
import { shouldShowCiCdNav } from '~/utils/cicdSetupState'
import { isStoreReleaseValidated } from '~/utils/gettingStartedDismiss'
import { getAppGettingStartedPath } from '~/utils/onboardingRedirect'

const props = withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const capgo = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const userId = computed(() => main.user?.id ?? main.auth?.id ?? '')

// Keep the sidebar short in large organizations: the most recently active apps first.
const MAX_CICD_ENTRIES = 3

function lastActivity(app: OrganizationApp) {
  const features = parseAppOnboardingLedger(app.onboarding).features ?? {}
  return [features.ota?.last_used_at, features.builder?.last_used_at, features.ota?.succeeded_at, features.builder?.succeeded_at]
    .filter((value): value is string => !!value)
    .sort((a, b) => a.localeCompare(b))
    .at(-1) ?? ''
}

const appEntries = computed(() => {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !userId.value)
    return { gettingStarted: [] as OrganizationApp[], cicd: [] as OrganizationApp[] }

  const gettingStarted: OrganizationApp[] = []
  const cicd: OrganizationApp[] = []
  for (const app of organizationStore.getAppsByOrgId(orgId)) {
    const showGettingStarted = shouldShowGettingStartedNav(app.onboarding, {
      storeReleaseValidated: isStoreReleaseValidated(userId.value, app.app_id),
    })
    if (showGettingStarted)
      gettingStarted.push(app)
    // After Getting started, the next nudge is automating releases from CI.
    else if (shouldShowCiCdNav(app.onboarding, showGettingStarted))
      cicd.push(app)
  }
  cicd.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))
  return { gettingStarted, cicd: cicd.slice(0, MAX_CICD_ENTRIES) }
})
const apps = computed(() => appEntries.value.gettingStarted)
const cicdApps = computed(() => appEntries.value.cicd)

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

function isActive(appId: string) {
  return route.path === getAppGettingStartedPath(appId)
}

function cicdPath(appId: string) {
  return `/app/${encodeURIComponent(appId)}/ci-cd`
}

function isCiCdActive(appId: string) {
  return route.path === cicdPath(appId)
}

async function persistDismiss(app: OrganizationApp) {
  const { data, error } = await capgo.rpc('dismiss_getting_started', {
    p_app_id: app.app_id,
  })
  const current = organizationStore.getAppByAppId(app.app_id)?.onboarding ?? app.onboarding ?? {}
  if (error) {
    console.error('Failed to dismiss getting started', error)
    organizationStore.updateAppOnboarding(app.app_id, withoutGettingStartedDismissed(current))
    organizationStore.updateAppNeedOnboarding(app.app_id, app.need_onboarding)
    return
  }
  organizationStore.updateAppOnboarding(
    app.app_id,
    withGettingStartedDismissed(current, parseAppOnboardingLedger(data).getting_started_dismissed_at ?? undefined),
  )
  const { data: row, error: needError } = await capgo
    .from('apps')
    .select('need_onboarding')
    .eq('app_id', app.app_id)
    .maybeSingle()
  if (needError || !row)
    return
  organizationStore.updateAppNeedOnboarding(app.app_id, row.need_onboarding)
}

function dismiss(app: OrganizationApp, event: Event) {
  event.preventDefault()
  event.stopPropagation()
  organizationStore.updateAppOnboarding(app.app_id, withGettingStartedDismissed(app.onboarding))
  organizationStore.updateAppNeedOnboarding(app.app_id, false)
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
  <div v-if="apps.length || cicdApps.length" data-test="getting-started-nav" class="pt-2">
    <ul class="max-h-56 space-y-1 overflow-y-auto">
      <li v-for="app in apps" :key="app.app_id">
        <div
          class="flex items-center rounded-lg transition-colors duration-150"
          :class="isActive(app.app_id) ? 'bg-azure-500/20' : 'bg-azure-500/10 hover:bg-azure-500/20'"
        >
          <router-link
            class="d-btn d-btn-ghost flex min-h-11 h-auto min-w-0 flex-1 items-center justify-start border-none bg-transparent p-0 shadow-none hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
            :to="{ path: getAppGettingStartedPath(app.app_id), query: { showChecklist: '1' } }"
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
            class="flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors duration-150 hover:bg-slate-700/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
            :aria-label="`${t('getting-started-dismiss')} — ${appLabel(app)}`"
            data-test="getting-started-nav-dismiss"
            @click="dismiss(app, $event)"
          >
            <IconX class="size-4" />
          </button>
        </div>
      </li>
      <li v-for="app in cicdApps" :key="`cicd-${app.app_id}`">
        <!-- No dismiss button: this stays until CI ships once or the guide marks it set up. -->
        <router-link
          class="d-btn d-btn-ghost flex min-h-11 h-auto w-full min-w-0 items-center justify-start rounded-lg border-none p-0 shadow-none transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
          :class="isCiCdActive(app.app_id) ? 'bg-azure-500/20 hover:bg-azure-500/20' : 'bg-azure-500/10 hover:bg-azure-500/20'"
          :to="cicdPath(app.app_id)"
          :aria-current="isCiCdActive(app.app_id) ? 'page' : undefined"
          :aria-label="`${t('setup-checklist-cicd-start')} — ${appLabel(app)}`"
          :title="`${t('setup-checklist-cicd-start')} — ${appLabel(app)}`"
          data-test="cicd-nav-link"
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
              v-else
              class="flex size-6 shrink-0 items-center justify-center rounded-sm bg-slate-700 text-[10px] font-semibold text-slate-200 d-mask d-mask-squircle"
              aria-hidden="true"
            >
              {{ acronym(appLabel(app)) }}
            </span>
          </span>
          <span class="min-w-0 truncate pr-2 text-sm font-medium text-azure-100 whitespace-nowrap">
            {{ t('setup-checklist-cicd-start') }}
          </span>
        </router-link>
      </li>
    </ul>
  </div>
</template>
