<script setup lang="ts">
import { onClickOutside, onKeyStroke, useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconLogout from '~icons/lucide/log-out'
import IconUser from '~icons/lucide/user-round-cog'
import { useMainStore } from '~/stores/main'
import { allowOnboardingDashboardExploration } from '~/utils/onboardingRedirect'

const props = withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const main = useMainStore()
const trigger = useTemplateRef<HTMLButtonElement>('trigger')
const menu = useTemplateRef<HTMLElement>('menu')
const open = ref(false)
const isLoggingOut = ref(false)
const compactMenuStyle = ref<Record<string, string>>({})
const displayName = computed(() => `${main.user?.first_name ?? ''} ${main.user?.last_name ?? ''}`.trim())
const triggerLabel = computed(() => [displayName.value, main.user?.email].filter(Boolean).join(', '))
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

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus)
    trigger.value?.focus()
}

// The rail is too narrow for the menu, so it opens beside the sidebar instead of above the trigger.
function placeCompactMenu() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect)
    return
  // The trigger is wider than the visible rail, so align on the sidebar edge.
  const railRight = trigger.value?.closest('#sidebar')?.getBoundingClientRect().right ?? rect.right
  compactMenuStyle.value = {
    left: `${Math.round(railRight + 8)}px`,
    bottom: `${Math.round(window.innerHeight - rect.bottom)}px`,
  }
}

async function toggle() {
  open.value = !open.value
  if (!open.value)
    return
  if (props.compact)
    placeCompactMenu()
  await nextTick()
  menu.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
}

onClickOutside(menu, () => close(), { ignore: [trigger] })
onKeyStroke('Escape', () => {
  if (open.value)
    close(true)
})
// Mobile browsers fire resize when the URL bar moves, so only reposition instead of closing.
useEventListener(window, 'resize', () => {
  if (open.value && props.compact)
    placeCompactMenu()
})
watch(() => route.fullPath, () => close())

function allowPendingOnboardingDashboardExploration() {
  const resumeAppId = typeof route.query.resume === 'string' ? route.query.resume : null
  if (route.path === '/app/new' && resumeAppId)
    allowOnboardingDashboardExploration(main.user?.id ?? main.auth?.id, resumeAppId)
}

async function openAccountSettings() {
  allowPendingOnboardingDashboardExploration()
  close()
  await router.push('/settings/account')
}

async function logOut() {
  if (isLoggingOut.value)
    return
  isLoggingOut.value = true
  try {
    await main.logout()
    await router.replace('/login')
  }
  finally {
    isLoggingOut.value = false
  }
}
</script>

<template>
  <div class="relative">
    <button
      ref="trigger"
      type="button"
      class="flex items-center w-full min-h-11 rounded-lg cursor-pointer text-left text-gray-300 hover:bg-slate-700/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      :class="{ 'bg-slate-700/50': open }"
      :title="props.compact ? displayName || main.user?.email : undefined"
      :aria-label="triggerLabel"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-test="sidebar-account"
      @click="toggle"
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
        <span class="block text-sm text-gray-400 truncate">
          {{ main.user?.email }}
        </span>
      </span>
    </button>
    <Teleport to="body" :disabled="!props.compact">
      <div
        v-if="open"
        ref="menu"
        role="menu"
        data-test="sidebar-account-menu"
        class="p-1.5 rounded-xl border border-slate-600/70 bg-slate-800 text-slate-200 shadow-2xl shadow-black/40"
        :class="props.compact ? 'fixed z-[100] w-60' : 'absolute inset-x-0 bottom-full mb-1.5 z-50'"
        :style="props.compact ? compactMenuStyle : undefined"
      >
        <button
          type="button"
          role="menuitem"
          data-test="sidebar-account-settings"
          class="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg cursor-pointer hover:bg-slate-700 focus:outline-none focus-visible:bg-slate-700"
          @click="openAccountSettings"
        >
          <IconUser class="size-4 shrink-0 text-slate-400" aria-hidden="true" />
          {{ t('account-settings') }}
        </button>
        <div class="my-1.5 h-px bg-slate-700" role="separator" />
        <button
          type="button"
          role="menuitem"
          data-test="sidebar-sign-out"
          class="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg cursor-pointer hover:bg-slate-700 focus:outline-none focus-visible:bg-slate-700 disabled:opacity-50"
          :disabled="isLoggingOut"
          @click="logOut"
        >
          <IconLogout class="size-4 shrink-0 text-slate-400" aria-hidden="true" />
          {{ t('sign-out') }}
        </button>
      </div>
    </Teleport>
  </div>
</template>
