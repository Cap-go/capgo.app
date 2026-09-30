<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconLightBulb from '~icons/heroicons/light-bulb'
import IconClose from '~icons/heroicons/x-mark'

const props = withDefaults(defineProps<{
  /** Show a link to the credits page (useless when already on it). */
  showLink?: boolean
}>(), {
  showLink: false,
})

const { t } = useI18n()

// Many users assume credits need a subscription. This is a secondary option,
// so it stays a small tip: shown until dismissed once, then collapses to a
// question pill that re-opens it on demand.
const dismissed = useLocalStorage('capgo-credits-only-tip-dismissed', false)
const open = ref(!dismissed.value)

function dismiss() {
  dismissed.value = true
  open.value = false
}
</script>

<template>
  <div data-test="credits-only-tip">
    <button
      v-if="!open"
      type="button"
      class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full ring-1 ring-slate-300 text-slate-600 hover:bg-white hover:text-slate-900 dark:ring-white/15 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
      :aria-expanded="false"
      aria-controls="credits-only-tip"
      data-test="credits-only-tip-toggle"
      @click="open = true"
    >
      <IconLightBulb class="w-4 h-4" aria-hidden="true" />
      {{ t('credits-only-tip-question') }}
    </button>

    <div
      v-else
      id="credits-only-tip"
      class="relative flex items-start gap-3 p-4 pr-12 rounded-xl bg-white ring-1 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/10"
    >
      <IconLightBulb class="w-5 h-5 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
      <div class="min-w-0">
        <p class="text-sm font-semibold text-slate-900 dark:text-white">
          {{ t('credits-only-tip-title') }}
        </p>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('credits-only-tip-description') }}
          <router-link
            v-if="props.showLink"
            to="/settings/organization/credits"
            class="font-medium whitespace-nowrap rounded-sm text-blue-700 hover:underline dark:text-azure-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
          >
            {{ t('credits-only-tip-link') }}
          </router-link>
        </p>
      </div>
      <button
        type="button"
        class="absolute flex items-center justify-center rounded-md top-2 right-2 size-8 text-slate-400 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
        :aria-label="t('credits-only-tip-dismiss')"
        :title="t('credits-only-tip-dismiss')"
        data-test="credits-only-tip-dismiss"
        @click="dismiss"
      >
        <IconClose class="w-5 h-5" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
