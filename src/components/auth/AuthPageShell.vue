<script setup lang="ts">
import type { Component } from 'vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import IconRollback from '~icons/heroicons/arrow-uturn-left'
import IconDevice from '~icons/heroicons/device-phone-mobile'
import IconTeam from '~icons/heroicons/user-group'

interface HighlightItem {
  icon?: Component
  title: string
  description: string
}

const props = withDefaults(defineProps<{
  badgeText?: string
  cardDescription?: string
  cardKicker?: string
  cardTitle: string
  cardWidthClass?: string
  chips?: string[]
  heroDescription?: string
  heroHighlights?: HighlightItem[]
  heroKicker?: string
  heroTitle?: string
}>(), {
  badgeText: import.meta.env.VITE_APP_VERSION,
  cardDescription: '',
  cardKicker: '',
  cardWidthClass: 'max-w-lg',
  chips: undefined,
  heroDescription: '',
  heroHighlights: undefined,
  heroKicker: '',
  heroTitle: '',
})

const { t } = useI18n()

const heroKickerValue = computed(() => props.heroKicker || t('login-console-kicker'))
const heroTitleValue = computed(() => props.heroTitle || t('login-console-title'))
const heroDescriptionValue = computed(() => props.heroDescription || t('login-console-description'))
const heroChips = computed(() => props.chips ?? [
  t('login-chip-live-updates'),
  t('login-chip-release-analytics'),
  t('login-chip-channel-control'),
])
const heroHighlights = computed(() => props.heroHighlights ?? [
  {
    icon: IconRollback,
    title: t('login-highlight-rollouts-title'),
    description: t('login-highlight-rollouts-description'),
  },
  {
    icon: IconDevice,
    title: t('login-highlight-observability-title'),
    description: t('login-highlight-observability-description'),
  },
  {
    icon: IconTeam,
    title: t('login-highlight-team-title'),
    description: t('login-highlight-team-description'),
  },
])
</script>

<template>
  <section
    class="relative flex h-dvh min-h-dvh w-full overflow-y-auto bg-[linear-gradient(180deg,rgba(248,250,252,0.98)_0%,rgba(238,244,255,0.9)_55%,rgba(248,250,252,0.98)_100%)] dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.98)_0%,rgba(20,29,53,0.96)_52%,rgba(15,23,42,0.98)_100%)]"
  >
    <div class="pointer-events-none absolute inset-0 hidden overflow-hidden lg:block" aria-hidden="true">
      <div class="absolute top-[10%] -left-32 h-[22rem] w-[22rem] rounded-full bg-[rgba(17,158,255,0.22)] opacity-55 blur-[52px]" />
      <div class="absolute right-[-7rem] bottom-[8%] h-[18rem] w-[18rem] rounded-full bg-[rgba(104,118,225,0.18)] opacity-55 blur-[52px]" />
      <div
        class="absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:3rem_3rem] [mask-image:radial-gradient(circle_at_center,black_40%,transparent_82%)]"
      />
    </div>

    <div class="relative mx-auto grid w-full max-w-7xl gap-6 px-4 py-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8 lg:min-h-dvh lg:grid-cols-[minmax(0,1.08fr)_minmax(24rem,30rem)] lg:items-center lg:gap-8 lg:px-8 lg:py-10 xl:grid-cols-[minmax(0,1.12fr)_minmax(24rem,32rem)]">
      <section class="hidden lg:block">
        <div class="max-w-2xl">
          <div class="inline-flex flex-wrap gap-2">
            <span
              v-for="chip in heroChips"
              :key="chip"
              class="rounded-full border border-white/60 bg-white/70 px-3 py-1 text-xs font-medium tracking-[0.18em] text-slate-600 uppercase shadow-sm backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/60 dark:text-slate-200"
            >
              {{ chip }}
            </span>
          </div>

          <div class="mt-8 space-y-5">
            <div class="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200/70 bg-white/80 shadow-lg shadow-slate-900/5 backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/70">
              <img src="/capgo.webp" alt="Capgo logo" class="h-8 w-8 rounded-sm invert dark:invert-0">
            </div>
            <div>
              <p class="text-xs font-semibold tracking-[0.26em] text-slate-500 uppercase dark:text-slate-300">
                {{ heroKickerValue }}
              </p>
              <h1 class="mt-4 text-4xl font-semibold leading-tight text-balance text-slate-950 dark:text-white xl:text-5xl">
                {{ heroTitleValue }}
              </h1>
              <p class="mt-5 max-w-xl text-base leading-7 text-slate-600 dark:text-slate-300 xl:text-lg">
                {{ heroDescriptionValue }}
              </p>
            </div>
          </div>

          <div class="mt-10 grid gap-4 sm:grid-cols-3">
            <article
              v-for="highlight in heroHighlights"
              :key="highlight.title"
              class="rounded-3xl border border-white/70 bg-white/78 p-5 shadow-[0_20px_50px_-30px_rgba(15,23,42,0.45)] backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/72"
            >
              <span class="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-azure-500/10 text-blue-700 ring-1 ring-azure-500/20 dark:text-azure-400" aria-hidden="true">
                <component :is="highlight.icon" class="h-5 w-5" />
              </span>
              <h2 class="text-base font-semibold text-slate-900 dark:text-white">
                {{ highlight.title }}
              </h2>
              <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ highlight.description }}
              </p>
            </article>
          </div>
        </div>
      </section>

      <div class="relative mx-auto flex w-full min-w-0 max-w-[calc(100vw-2rem)]! flex-col lg:block lg:max-w-none!" :class="cardWidthClass">
        <div class="mb-5 flex items-center gap-3 lg:hidden">
          <span class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200/80 bg-white/80 shadow-sm dark:border-slate-700 dark:bg-slate-900/70">
            <img src="/capgo.webp" alt="Capgo logo" class="h-7 w-7 rounded-sm invert dark:invert-0">
          </span>
          <div class="min-w-0">
            <p class="text-[0.7rem] font-semibold tracking-[0.18em] text-slate-500 uppercase dark:text-slate-300">
              {{ heroKickerValue }}
            </p>
            <p class="mt-1 truncate text-sm font-medium text-slate-600 dark:text-slate-300">
              Capgo
            </p>
          </div>
        </div>

        <div class="rounded-none border-0 bg-transparent p-0 shadow-none backdrop-blur-0 sm:rounded-[1.75rem] sm:border sm:border-slate-200/75 sm:bg-[linear-gradient(180deg,rgba(255,255,255,0.94)_0%,rgba(255,255,255,0.84)_100%)] sm:p-7 sm:shadow-[0_34px_80px_-42px_rgba(15,23,42,0.5)] sm:backdrop-blur-[18px] sm:dark:border-slate-600/70 sm:dark:bg-[linear-gradient(180deg,rgba(15,23,42,0.88)_0%,rgba(15,23,42,0.7)_100%)]">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p v-if="cardKicker" class="text-[0.72rem] font-bold tracking-[0.22em] text-slate-500 uppercase dark:text-slate-400">
                {{ cardKicker }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold leading-tight text-slate-950 dark:text-white sm:mt-3">
                {{ cardTitle }}
              </h2>
              <p v-if="cardDescription" class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-300">
                {{ cardDescription }}
              </p>
            </div>
            <span
              v-if="badgeText"
              class="self-start shrink-0 rounded-full border border-slate-300/90 bg-white/90 px-3 py-1.5 text-[0.72rem] font-semibold text-slate-600 dark:border-slate-600/90 dark:bg-slate-800/90 dark:text-slate-200 sm:bg-slate-50/95 sm:px-3.5 sm:py-2 sm:text-[0.78rem]"
            >
              {{ badgeText }}
            </span>
          </div>

          <div class="mt-5 text-slate-500 dark:text-slate-300 sm:mt-6">
            <slot />
          </div>
        </div>

        <slot name="footer" />
      </div>
    </div>
  </section>
</template>
