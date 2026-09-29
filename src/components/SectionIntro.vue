<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconExternal from '~icons/heroicons/arrow-top-right-on-square'

type Section = 'apps' | 'bundles' | 'channels' | 'devices' | 'builds' | 'apikeys'

const props = defineProps<{
  section: Section
}>()

const { t } = useI18n()
const route = useRoute()

// Plain-language framing for each console area. The group eyebrow matches the
// product groups on capgo.app so the console and the website tell one story.
const sections: Record<Section, { group: string, title: string, description: string, docs: string }> = {
  apps: { group: 'section-group-workspace', title: 'apps', description: 'apps-description', docs: 'https://capgo.app/docs/getting-started/add-an-app/' },
  bundles: { group: 'section-group-ship', title: 'bundles', description: 'bundles-description', docs: 'https://capgo.app/docs/webapp/bundles/' },
  channels: { group: 'section-group-ship', title: 'channels', description: 'channels-description', docs: 'https://capgo.app/docs/live-updates/channels/' },
  builds: { group: 'section-group-ship', title: 'builds', description: 'builds-description', docs: 'https://capgo.app/docs/cli/cloud-build/' },
  devices: { group: 'section-group-monitor', title: 'devices', description: 'devices-description', docs: 'https://capgo.app/docs/webapp/devices/' },
  apikeys: { group: 'section-group-workspace', title: 'api-keys', description: 'apikeys-description', docs: 'https://capgo.app/docs/public-api/api-keys/' },
}

const config = computed(() => sections[props.section])

// Bundles, channels, and devices are one pipeline. Showing where the current
// page sits in it answers "what is this and what happens next?".
const flowSteps = [
  { section: 'bundles', label: 'flow-step-bundle', path: '/bundles' },
  { section: 'channels', label: 'flow-step-channel', path: '/channels' },
  { section: 'devices', label: 'flow-step-devices', path: '/devices' },
] as const

const appRouteSegment = computed(() => route.path.match(/^\/app\/([^/]+)/)?.[1] ?? '')
const showFlow = computed(() => !!appRouteSegment.value && flowSteps.some(step => step.section === props.section))
// Top-level pages already carry their title in the navbar; app pages only show
// a breadcrumb there, so they get a real heading here.
const showHeading = computed(() => !!appRouteSegment.value)
</script>

<template>
  <section
    class="flex flex-col gap-4 px-4 pb-6 sm:px-0 lg:flex-row lg:items-end lg:justify-between"
    :aria-label="t(config.title)"
    data-test="section-intro"
  >
    <div class="min-w-0">
      <template v-if="showHeading">
        <p class="font-mono text-xs font-semibold tracking-widest uppercase text-blue-700 dark:text-azure-400">
          {{ t(config.group) }}
        </p>
        <h1 class="mt-1 text-xl font-semibold tracking-tight text-slate-900 first-letter:uppercase dark:text-white">
          {{ t(config.title) }}
        </h1>
      </template>
      <p class="text-sm max-w-2xl text-slate-600 dark:text-slate-400" :class="{ 'mt-1': showHeading }">
        {{ t(config.description) }}
        <a
          :href="config.docs"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 font-medium whitespace-nowrap rounded-sm text-blue-700 hover:underline dark:text-azure-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
        >
          {{ t('learn-more') }}
          <IconExternal class="w-3 h-3" aria-hidden="true" />
          <span class="sr-only">({{ t('open-in-new-tab') }})</span>
        </a>
      </p>
    </div>

    <nav v-if="showFlow" :aria-label="t('flow-label')" class="shrink-0">
      <ol class="flex items-center w-fit max-w-full gap-1 p-1 overflow-x-auto text-xs font-medium rounded-full no-scrollbar bg-white ring-1 ring-slate-200 dark:bg-white/5 dark:ring-white/10">
        <li v-for="(step, i) in flowSteps" :key="step.section" class="flex items-center gap-1 shrink-0">
          <span v-if="i > 0" class="text-slate-400 dark:text-slate-600" aria-hidden="true">→</span>
          <span
            v-if="step.section === section"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-azure-500/10 text-blue-700 ring-1 ring-azure-500/30 dark:text-azure-300"
            aria-current="step"
          >
            <span class="font-mono text-[10px] opacity-70">{{ i + 1 }}</span>
            {{ t(step.label) }}
          </span>
          <router-link
            v-else
            :to="`/app/${appRouteSegment}${step.path}`"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500"
          >
            <span class="font-mono text-[10px] opacity-70">{{ i + 1 }}</span>
            {{ t(step.label) }}
          </router-link>
        </li>
      </ol>
    </nav>
  </section>
</template>
