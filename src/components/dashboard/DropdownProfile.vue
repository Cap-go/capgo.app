<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconSettings from '~icons/lucide/settings'
import { useMainStore } from '~/stores/main'
import { allowOnboardingDashboardExploration } from '~/utils/onboardingRedirect'

const props = withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})

const { t } = useI18n()
const route = useRoute()
const main = useMainStore()
const displayName = computed(() => `${main.user?.first_name ?? ''} ${main.user?.last_name ?? ''}`.trim())
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

function allowPendingOnboardingDashboardExploration() {
  const resumeAppId = typeof route.query.resume === 'string' ? route.query.resume : null
  if (route.path === '/app/new' && resumeAppId)
    allowOnboardingDashboardExploration(main.user?.id ?? main.auth?.id, resumeAppId)
}
</script>

<template>
  <router-link
    to="/settings/account"
    class="flex items-center w-full min-h-11 rounded-lg cursor-pointer text-gray-300 hover:bg-slate-700/50 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none focus:ring-offset-slate-800"
    :title="props.compact ? displayName || t('settings') : t('settings')"
    data-test="sidebar-account"
    @click="allowPendingOnboardingDashboardExploration"
  >
    <span class="flex w-12 h-11 shrink-0 items-center justify-center">
      <img v-if="main.user?.image_url" class="w-8 h-8 d-mask d-mask-squircle" :src="main.user?.image_url" alt="" width="32" height="32">
      <span v-else class="flex items-center justify-center w-8 h-8 bg-gray-700 d-mask d-mask-squircle">
        <span class="font-medium">
          {{ acronym }}
        </span>
      </span>
    </span>
    <span class="min-w-0 flex-1 py-2 pr-3">
      <span class="block font-medium truncate">
        {{ displayName }}
      </span>
      <span class="flex items-center gap-1 min-w-0">
        <span class="block text-sm text-gray-400 truncate min-w-0 flex-1">
          {{ main.user?.email }}
        </span>
        <IconSettings class="size-4 text-slate-300 shrink-0" aria-hidden="true" />
      </span>
    </span>
  </router-link>
</template>
