<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconPanelLeft from '~icons/lucide/panel-left'
import IconBack from '~icons/material-symbols/arrow-back-ios-rounded'
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
const isMobile = ref(Capacitor.isNativePlatform())

const router = useRouter()

const displayStore = useDisplayStore()
const lastBreadcrumbName = computed(() => displayStore.pathTitle.at(-1)?.name)
const showNavTitle = computed(() => displayStore.NavTitle && displayStore.pathTitle.length === 0)
function back() {
  if (window.history.length > 2)
    router.back()
  else
    router.push(displayStore.defaultBack)
}
const { t } = useI18n()
</script>

<template>
  <header class="relative z-40 bg-slate-100 backdrop-blur-xl dark:bg-slate-900">
    <div class="px-2 sm:px-4 lg:px-6">
      <div class="relative flex items-center h-16 -mb-px">
        <!-- Header: Left side -->
        <div class="z-10 flex shrink-0 items-center gap-0.5 sm:gap-1 lg:gap-3">
          <div v-if="displayStore.NavTitle && isMobile">
            <button
              type="button"
              class="flex rounded-sm p-0.5 dark:text-white focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none text-slate-500 dark:hover:bg-slate-600 hover:bg-slate-300"
              :aria-label="t('button-back')"
              @click="back()"
            >
              <IconBack class="h-4 w-4 fill-current" />
              <span class="hidden md:block">{{ t('button-back') }}</span>
            </button>
          </div>
          <div class="hidden lg:block">
            <button
              type="button"
              class="d-btn d-btn-ghost d-btn-square d-btn-sm dark:text-white focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none text-slate-500 dark:hover:text-slate-50 hover:text-slate-600"
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
            class="rounded-md p-0.5 lg:hidden dark:text-white focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none text-slate-500 dark:hover:text-slate-50 hover:text-slate-600"
            data-test="sidebar-mobile-toggle"
            aria-controls="sidebar"
            :aria-expanded="props.sidebarOpen"
            :aria-label="props.sidebarOpen ? t('close-sidebar') : t('open-sidebar')"
            @click.stop="$emit('toggleSidebar')"
          >
            <span class="sr-only">{{ props.sidebarOpen ? t('close-sidebar') : t('open-sidebar') }}</span>
            <IconMenu class="h-4 w-4 fill-current" />
          </button>

          <!-- Title on desktop -->
          <div class="hidden lg:block">
            <div class="flex items-center space-x-2 font-bold truncate md:text-2xl dark:text-white text-md text-dark">
              <nav class="text-sm font-normal text-slate-600 dark:text-slate-400" aria-label="Breadcrumb">
                <ol class="inline-flex items-center space-x-1">
                  <li v-for="(breadcrumb, i) in displayStore.pathTitle" :key="i" class="flex items-center">
                    <span v-if="i > 0" class="mx-1" aria-hidden="true"> / </span>
                    <!-- Last crumb points at the current route, so render it as plain text rather than a dead link -->
                    <span
                      v-if="i === displayStore.pathTitle.length - 1"
                      class="flex items-center h-16 px-2 font-bold text-slate-600 dark:text-slate-100"
                      aria-current="page"
                    >
                      {{ breadcrumb.translate === false ? breadcrumb.name : t(breadcrumb.name) }}
                    </span>
                    <router-link
                      v-else
                      :to="breadcrumb.path"
                      class="flex items-center h-16 px-2 rounded-sm underline underline-offset-2 decoration-slate-400/60 hover:decoration-slate-600 hover:text-slate-800 dark:decoration-slate-500 dark:hover:decoration-slate-300 dark:hover:text-white focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:outline-none"
                    >
                      {{ breadcrumb.translate === false ? breadcrumb.name : t(breadcrumb.name) }}
                    </router-link>
                  </li>
                  <li v-if="displayStore.pathTitle.length && displayStore.NavTitle && displayStore.NavTitle !== lastBreadcrumbName" class="flex items-center">
                    <span class="mx-1" aria-hidden="true"> / </span>
                  </li>
                  <li v-if="showNavTitle" class="flex items-center">
                    <span class="mx-1 font-bold text-slate-600 dark:text-slate-100 md:text-2xl" aria-hidden="true">{{ displayStore.NavTitle }}</span>
                  </li>
                </ol>
              </nav>
            </div>
          </div>
        </div>

        <!-- Mobile title: sr-only on Capacitor native so billing pills keep full width -->
        <div v-if="displayStore.NavTitle" class="lg:hidden">
          <span class="sr-only">{{ displayStore.NavTitle }}</span>
          <div
            v-if="!isMobile"
            class="pointer-events-none absolute inset-x-0 px-14 text-center"
          >
            <div class="mx-auto max-w-[38%] truncate font-bold text-md text-dark dark:text-white">
              {{ displayStore.NavTitle }}
            </div>
          </div>
        </div>

        <!-- Right side: Desktop banner -->
        <div class="hidden lg:ml-auto lg:flex">
          <Banner desktop />
        </div>

        <!-- Mobile banner in navbar -->
        <div class="z-10 flex min-w-0 flex-1 justify-end overflow-hidden lg:hidden">
          <Banner desktop />
        </div>
      </div>
    </div>
  </header>
</template>
