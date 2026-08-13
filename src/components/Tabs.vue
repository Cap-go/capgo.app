<script setup lang="ts">
import type { Tab } from './comp_def'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  tabs: Tab[]
  activeTab: string
  secondaryTabs?: Tab[]
  secondaryActiveTab?: string
  tertiaryTabs?: Tab[]
  tertiaryActiveTab?: string
  noWrap?: boolean
}>()

const emit = defineEmits(['update:activeTab', 'update:secondaryActiveTab', 'update:tertiaryActiveTab'])

const { t } = useI18n()

function activeTabColor(tab: string, level: 'primary' | 'secondary' | 'tertiary' = 'primary') {
  const isActive = level === 'primary'
    ? props.activeTab === tab
    : level === 'secondary'
      ? props.secondaryActiveTab === tab
      : props.tertiaryActiveTab === tab

  // Secondary / tertiary row tabs share the pill style
  if (level !== 'primary') {
    return isActive
      ? 'text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-800 border border-blue-200/70 dark:border-blue-800 shadow-sm hover:ring-1 hover:ring-blue-200 dark:hover:ring-blue-700 hover:bg-blue-50 dark:hover:bg-slate-900 transition-colors'
      : 'border border-transparent text-slate-500/75 dark:text-slate-400/75 hover:bg-white dark:hover:bg-slate-900 hover:text-slate-700 dark:hover:text-slate-200 transition-colors'
  }

  // Primary row tabs - open tab style. Overlay stays inside the button so scroll clip
  // cannot leave a gap between the selected tab and the panel border.
  return isActive
    ? 'text-blue-500 dark:text-blue-300 bg-blue-50 dark:bg-slate-800/40 border-t border-l border-r border-blue-200/60 dark:border-blue-800/70 border-b-0 before:pointer-events-none before:content-[\'\'] before:absolute before:inset-x-0 before:bottom-0 before:h-[2px] before:bg-blue-50 dark:before:bg-[#151e31] hover:bg-blue-100 hover:before:bg-blue-100 dark:hover:bg-[#1e3050] dark:hover:before:bg-[#1e3050] transition-colors'
    : 'border border-transparent text-slate-500/75 dark:text-slate-400/75 hover:bg-blue-100/70 dark:hover:bg-[#1a2744cc] hover:text-slate-700 dark:hover:text-slate-200 transition-colors'
}

const ulPrimaryClass = 'flex text-xs md:text-sm font-medium text-center text-gray-500 dark:text-gray-300 gap-1 pt-1 px-1'
const ulSecondaryClass = 'flex text-sm font-medium text-center text-gray-600 dark:text-gray-200 gap-2 py-2'
const ulTertiaryClass = 'flex text-sm font-medium text-center text-gray-600 dark:text-gray-200 gap-2 py-1.5'
const noWrapClass = 'flex-nowrap max-w-full overflow-x-auto overscroll-x-contain touch-pan-x no-scrollbar px-1'
const buttonPrimaryClass = 'inline-flex items-center gap-2 px-3 py-2 min-w-[42px] min-h-[38px] rounded-t-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50 dark:focus-visible:ring-offset-slate-900 transition-all group relative'
const buttonSecondaryClass = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50 dark:focus-visible:ring-offset-slate-900 transition-colors group'
const iconClass = 'w-5 h-5 transition-colors'
const labelClass = 'hidden md:block text-xs md:text-sm font-medium transition-colors first-letter:uppercase'
</script>

<template>
  <div class="w-full min-w-0 shrink-0">
    <div class="relative z-20 min-w-0 pb-0">
      <ul :class="[ulPrimaryClass, noWrap ? noWrapClass : 'flex-wrap']">
        <li v-for="(tab, i) in tabs" :key="i" class="relative mr-2" :class="{ 'z-20': activeTab === tab.key }">
          <button
            type="button"
            :aria-current="activeTab === tab.key ? 'page' : undefined"
            :aria-label="t(tab.label)"
            :class="[buttonPrimaryClass, activeTabColor(tab.key)]"
            @click="emit('update:activeTab', tab.key)"
          >
            <component :is="tab.icon" :class="iconClass" />
            <span :class="labelClass">{{ t(tab.label) }}</span>
            <span v-if="tab.badge" class="hidden px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded border md:inline border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t(tab.badge) }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div class="relative -mt-px border-t bg-blue-50 dark:bg-slate-800/40 border-blue-200/60 dark:border-blue-800/70" :class="secondaryTabs?.length ? 'z-10' : 'z-0'">
      <ul v-if="secondaryTabs?.length" :class="[ulSecondaryClass, noWrap ? noWrapClass : 'flex-wrap']">
        <li v-for="(tab, i) in secondaryTabs" :key="i" class="mr-2">
          <button
            type="button"
            :aria-current="secondaryActiveTab === tab.key ? 'page' : undefined"
            :aria-label="t(tab.label)"
            :class="[buttonSecondaryClass, activeTabColor(tab.key, 'secondary')]"
            @click="emit('update:secondaryActiveTab', tab.key)"
          >
            <component :is="tab.icon" :class="iconClass" />
            <span :class="labelClass">{{ t(tab.label) }}</span>
            <span v-if="tab.badge" class="hidden px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded border md:inline border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t(tab.badge) }}</span>
          </button>
        </li>
      </ul>
      <ul
        v-if="tertiaryTabs?.length"
        class="border-t border-blue-200/40 dark:border-blue-800/40"
        :class="[ulTertiaryClass, noWrap ? noWrapClass : 'flex-wrap']"
      >
        <li v-for="(tab, i) in tertiaryTabs" :key="i" class="mr-2">
          <button
            type="button"
            :aria-current="tertiaryActiveTab === tab.key ? 'page' : undefined"
            :aria-label="t(tab.label)"
            :class="[buttonSecondaryClass, activeTabColor(tab.key, 'tertiary')]"
            @click="emit('update:tertiaryActiveTab', tab.key)"
          >
            <component :is="tab.icon" :class="iconClass" />
            <span :class="labelClass">{{ t(tab.label) }}</span>
            <span v-if="tab.badge" class="hidden px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded border md:inline border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t(tab.badge) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
