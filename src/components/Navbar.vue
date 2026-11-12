<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconBuilding from '~icons/heroicons/building-office'
import IconUser from '~icons/heroicons/user'
import IconPanelLeft from '~icons/lucide/panel-left'
import IconMenu from '~icons/material-symbols/menu-rounded'
import { useDisplayStore } from '~/stores/display'
import Banner from './Banner.vue'

const props = defineProps({
  sidebarOpen: {
    type: Boolean,
    default: false,
  },
  sidebarCollapsed: {
    type: Boolean,
    default: false,
  },
})

defineEmits(['toggleSidebar', 'toggleSidebarCollapse'])
const displayStore = useDisplayStore()
const { t } = useI18n()
const showNavTitle = computed(() => displayStore.NavTitle && displayStore.pathTitle.length === 0)
const route = useRoute()
const settingsLink = computed(() => {
  const path = route.path
  if (path.startsWith('/settings/account'))
    return { to: '/settings/organization', label: 'organization', icon: IconBuilding }
  if (path.startsWith('/settings/organization') || path === '/billing' || path.startsWith('/billing/'))
    return { to: '/settings/account', label: 'account', icon: IconUser }
  return null
})
// Settings sub-pages have a parent crumb ("Organization") plus their own title
// ("Members"). Render that title as the current crumb instead of a dangling "/".
// Scoped to settings, where every page sets NavTitle, so a stale title never leaks.
const trailingTitle = computed(() => {
  const last = displayStore.pathTitle.at(-1)
  if (!route.path.startsWith('/settings/') || !last || !displayStore.NavTitle)
    return ''
  const lastName = last.translate === false ? last.name : t(last.name)
  return displayStore.NavTitle !== lastName ? displayStore.NavTitle : ''
})
// Mobile has no breadcrumbs, so fall back to the current crumb: without it,
// app pages show an empty header and users lose track of where they are.
const mobileTitle = computed(() => {
  if (displayStore.NavTitle)
    return displayStore.NavTitle
  const last = displayStore.pathTitle.at(-1)
  if (!last)
    return ''
  return last.translate === false ? last.name : t(last.name)
})
</script>

<template>
  <header class="relative z-40 bg-slate-100 backdrop-blur-xl dark:bg-slate-900">
    <div class="px-2 sm:px-4 lg:px-6">
      <div class="relative flex items-center justify-between h-16 -mb-px">
        <!-- Header: Left side -->
        <div class="flex items-center space-x-4 lg:space-x-3">
          <div class="hidden lg:block">
            <button
              type="button"
              class="d-btn d-btn-ghost d-btn-square d-btn-sm dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 text-slate-500 dark:hover:text-slate-50 hover:text-slate-600"
              data-test="sidebar-collapse-toggle"
              aria-controls="sidebar"
              :aria-expanded="!props.sidebarCollapsed"
              :aria-label="props.sidebarCollapsed ? t('expand-sidebar') : t('collapse-sidebar')"
              @click.stop="$emit('toggleSidebarCollapse')"
            >
              <span class="sr-only">{{ props.sidebarCollapsed ? t('expand-sidebar') : t('collapse-sidebar') }}</span>
              <IconPanelLeft class="h-5 w-5 [stroke-width:1.5]" />
            </button>
          </div>
          <!-- Hamburger button -->
          <button
            type="button"
            class="p-1 rounded-md lg:hidden dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 text-slate-500 dark:hover:text-slate-50 hover:text-slate-600"
            data-test="sidebar-mobile-toggle"
            aria-controls="sidebar"
            :aria-expanded="props.sidebarOpen"
            :aria-label="props.sidebarOpen ? t('close-sidebar') : t('open-sidebar')"
            @click.stop="$emit('toggleSidebar')"
          >
            <span class="sr-only">{{ props.sidebarOpen ? t('close-sidebar') : t('open-sidebar') }}</span>
            <IconMenu class="w-6 h-6 fill-current" />
          </button>

          <!-- Title on desktop -->
          <div class="hidden lg:block">
            <div class="flex items-center space-x-2 font-bold truncate md:text-2xl dark:text-white">
              <nav class="text-sm font-normal text-slate-600 dark:text-slate-400" aria-label="Breadcrumb">
                <ol class="inline-flex items-center space-x-1">
                  <li v-for="(breadcrumb, i) in displayStore.pathTitle" :key="i" class="flex items-center h-16">
                    <span v-if="i > 0" class="mx-1" aria-hidden="true"> / </span>
                    <!-- Last crumb points at the current route, so render it as plain text rather than a dead link -->
                    <span
                      v-if="i === displayStore.pathTitle.length - 1 && !trailingTitle"
                      class="flex items-center h-16 px-2 font-bold text-slate-600 dark:text-slate-100"
                      aria-current="page"
                    >
                      {{ breadcrumb.translate === false ? breadcrumb.name : t(breadcrumb.name) }}
                    </span>
                    <router-link
                      v-else
                      :to="breadcrumb.path"
                      class="flex items-center px-2 py-1 rounded-md underline underline-offset-2 decoration-slate-400/60 hover:bg-slate-200/70 hover:decoration-slate-600 hover:text-slate-800 active:bg-slate-200 dark:decoration-slate-500 dark:hover:bg-slate-800 dark:hover:decoration-slate-300 dark:hover:text-white dark:active:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      {{ breadcrumb.translate === false ? breadcrumb.name : t(breadcrumb.name) }}
                    </router-link>
                  </li>
                  <li v-if="trailingTitle" class="flex items-center">
                    <span class="mx-1" aria-hidden="true"> / </span>
                    <span class="flex items-center h-16 px-2 font-bold capitalize text-slate-600 dark:text-slate-100" aria-current="page">
                      {{ trailingTitle }}
                    </span>
                  </li>
                  <li v-if="showNavTitle" class="flex items-center">
                    <span class="mx-1 font-bold text-slate-600 dark:text-slate-100 md:text-2xl" aria-hidden="true">{{ displayStore.NavTitle }}</span>
                  </li>
                </ol>
              </nav>
            </div>
          </div>
        </div>

        <!-- Centered title on mobile -->
        <div class="min-w-0 flex-1 px-2 text-center lg:hidden">
          <div class="font-bold truncate dark:text-white first-letter:uppercase">
            {{ mobileTitle }}
          </div>
        </div>

        <!-- Right side: Desktop banner -->
        <div class="hidden lg:flex">
          <Banner desktop />
        </div>

        <!-- Keep the settings shortcut out of the scrollable mobile tab row. -->
        <div class="shrink-0 lg:hidden">
          <RouterLink
            v-if="settingsLink"
            :to="settingsLink.to"
            class="inline-flex items-center gap-1.5 min-h-11 px-2 text-sm font-medium rounded-md text-blue-600 hover:bg-blue-100/70 dark:text-blue-300 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            data-test="settings-switch-section"
          >
            <component :is="settingsLink.icon" class="w-4 h-4" aria-hidden="true" />
            {{ t(settingsLink.label) }}
          </RouterLink>
          <Banner v-else desktop />
        </div>
      </div>
    </div>
  </header>
</template>
