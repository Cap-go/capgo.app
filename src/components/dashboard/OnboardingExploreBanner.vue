<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCompass from '~icons/lucide/compass'

const props = defineProps<{
  appId: string
}>()

const { t } = useI18n()
const router = useRouter()

function continueOnboarding() {
  router.push(`/app/new?resume=${encodeURIComponent(props.appId)}`)
}
</script>

<template>
  <aside
    class="relative z-20 flex w-full shrink-0 items-center justify-between gap-3 overflow-hidden bg-primary-500 px-4 py-2.5 text-white shadow-sm sm:px-6"
    :aria-label="t('app-onboarding-progress-label')"
  >
    <div class="pointer-events-none absolute inset-0 opacity-20" aria-hidden="true">
      <div class="absolute -left-6 top-1/2 h-20 w-20 -translate-y-1/2 rounded-full border border-white/60" />
      <div class="absolute left-8 top-1/2 h-12 w-12 -translate-y-1/2 rounded-full border border-white/40" />
    </div>
    <div class="relative flex min-w-0 items-center gap-3">
      <span class="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25 sm:flex">
        <IconCompass class="h-4 w-4" />
      </span>
      <div class="min-w-0 sm:flex sm:items-baseline sm:gap-2">
        <p class="truncate text-sm font-semibold">
          {{ t('app-onboarding-exploring-title') }}
        </p>
        <p class="hidden text-xs text-white/75 md:block">
          {{ t('app-onboarding-exploring-subtitle') }}
        </p>
      </div>
    </div>
    <button
      type="button"
      class="d-btn d-btn-sm relative shrink-0 border-white/25 bg-white text-slate-950 shadow-sm hover:border-white hover:bg-white/90"
      @click="continueOnboarding"
    >
      <span class="hidden sm:inline">{{ t('app-onboarding-continue-setup') }}</span>
      <span class="sm:hidden">{{ t('app-onboarding-continue-short') }}</span>
      <IconArrowRight class="h-4 w-4" />
    </button>
  </aside>
</template>
