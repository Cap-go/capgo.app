<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconClipboard from '~icons/lucide/clipboard'
import IconExternalLink from '~icons/lucide/external-link'
import IconGlobe from '~icons/lucide/globe'
import IconSettings from '~icons/lucide/settings'
import { useAppUpdateModeStore } from '~/stores/appUpdateMode'

const props = defineProps<{ appId: string }>()

const { t } = useI18n()
const appUpdateModeStore = useAppUpdateModeStore()
const websiteUrl = computed(() => appUpdateModeStore.get(props.appId)?.websiteUrl ?? '')
const settingsPath = computed(() => `/app/${encodeURIComponent(props.appId)}/settings`)

const installCommand = 'npm install @capgo/capacitor-updater && npx cap sync'
const configSnippet = computed(() => `// capacitor.config.ts
plugins: {
  CapacitorUpdater: {
    appId: '${props.appId}',
    websiteMode: true,
    autoUpdate: true,
  },
},`)
const readySnippet = `import { CapacitorUpdater } from '@capgo/capacitor-updater'

// Call this as soon as your app has started correctly.
// If it is not called, the update is rolled back automatically.
CapacitorUpdater.notifyAppReady()`

const setupSteps = computed(() => [
  { key: 'install', title: t('website-live-setup-install'), code: installCommand },
  { key: 'config', title: t('website-live-setup-config'), code: configSnippet.value },
  { key: 'ready', title: t('website-live-setup-ready'), code: readySnippet },
  { key: 'release', title: t('website-live-setup-release'), code: '' },
  { key: 'deploy', title: t('website-live-setup-deploy'), code: '' },
])

const hiddenFeatures = computed(() => [
  t('website-live-hidden-channels'),
  t('website-live-hidden-stats'),
  t('website-live-hidden-bundles'),
  t('website-live-hidden-encryption'),
  t('website-live-hidden-builds'),
])

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('copied-to-clipboard'))
  }
  catch {
    toast.error(t('cannot-copy'))
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6" data-test="website-live-overview">
    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="flex items-start gap-3">
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-azure-500 text-white">
            <IconGlobe class="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p class="text-sm font-semibold text-azure-500">
              {{ t('website-live') }}
            </p>
            <h1 class="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">
              {{ t('website-live-overview-title') }}
            </h1>
            <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('website-live-overview-description') }}
            </p>
          </div>
        </div>
        <RouterLink :to="settingsPath" class="d-btn min-h-10 shrink-0" data-test="website-live-open-settings">
          <IconSettings class="h-4 w-4" aria-hidden="true" />
          {{ t('website-live-change-settings') }}
        </RouterLink>
      </div>
      <div class="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/60">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ t('website-live-url-label') }}
        </p>
        <a
          v-if="websiteUrl"
          :href="websiteUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-azure-600 hover:underline dark:text-azure-400"
        >
          {{ websiteUrl }}
          <IconExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
        {{ t('website-live-setup-title') }}
      </h2>
      <ol class="mt-4 space-y-4">
        <li v-for="(step, index) in setupSteps" :key="step.key" class="flex gap-3">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200" aria-hidden="true">
            {{ index + 1 }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-slate-700 dark:text-slate-200">
              {{ step.title }}
            </p>
            <div v-if="step.code" class="relative mt-2">
              <pre class="overflow-x-auto rounded-lg bg-slate-950 p-3 pr-12 text-xs leading-5 text-slate-100"><code>{{ step.code }}</code></pre>
              <button
                type="button"
                class="absolute right-2 top-2 rounded-md p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                :aria-label="t('copy')"
                @click="copy(step.code)"
              >
                <IconClipboard class="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </li>
      </ol>
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
        {{ t('website-live-hidden-title') }}
      </h2>
      <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ t('website-live-hidden-description') }}
      </p>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
        <li v-for="feature in hiddenFeatures" :key="feature">
          {{ feature }}
        </li>
      </ul>
      <RouterLink :to="settingsPath" class="d-btn d-btn-primary mt-4 min-h-10">
        {{ t('website-live-upgrade-cta') }}
      </RouterLink>
    </section>
  </div>
</template>
