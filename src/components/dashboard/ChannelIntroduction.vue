<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconExternal from '~icons/lucide/arrow-up-right'
import IconGitBranch from '~icons/lucide/git-branch'
import ChannelConsoleAssignMockup from './ChannelConsoleAssignMockup.vue'
import ChannelDefaultRoutingMockup from './ChannelDefaultRoutingMockup.vue'
import ChannelSelfAssignMockup from './ChannelSelfAssignMockup.vue'

const props = defineProps<{ canCreate: boolean }>()

const emit = defineEmits<{ create: [] }>()
const { t } = useI18n()
const stage = ref<'default' | 'self-assign' | 'console-assign'>('default')
const animations = {
  'default': ChannelDefaultRoutingMockup,
  'self-assign': ChannelSelfAssignMockup,
  'console-assign': ChannelConsoleAssignMockup,
}
const animation = computed(() => animations[stage.value])

function goBack() {
  stage.value = stage.value === 'console-assign' ? 'self-assign' : 'default'
}

function continueIntroduction() {
  if (stage.value === 'default')
    stage.value = 'self-assign'
  else if (stage.value === 'self-assign')
    stage.value = 'console-assign'
  else if (props.canCreate)
    emit('create')
  else
    stage.value = 'default'
}
</script>

<template>
  <section class="channel-introduction p-4 sm:p-6" data-test="channel-introduction" :aria-label="t('channel-intro-title')">
    <header class="mb-6 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
      <div class="max-w-2xl">
        <span class="mb-3 inline-flex items-center gap-2 text-xs font-semibold text-blue-700 dark:text-sky-300">
          <IconGitBranch class="h-4 w-4" aria-hidden="true" />
          {{ t('channel-intro-kicker') }}
        </span>
        <h2 class="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
          {{ t('channel-intro-title') }}
        </h2>
        <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ t('channel-intro-description') }}
        </p>
      </div>
      <button
        v-if="canCreate"
        type="button"
        class="d-btn d-btn-primary min-h-11 shrink-0 self-start sm:self-center"
        data-test="channel-intro-create"
        @click="emit('create')"
      >
        {{ t('channel-create-onboarding-title') }}
        <IconArrowRight class="h-4 w-4" aria-hidden="true" />
      </button>
    </header>

    <!-- Keep this console surface out of onboarding experiment analytics. -->
    <component :is="animation" embedded @back="goBack" @continue="continueIntroduction">
      <template #continue-label>
        {{ t(canCreate ? 'continue' : 'channel-intro-replay') }}
      </template>
      <template #secondary-action>
        <a
          href="https://capgo.app/docs/live-updates/channels/"
          target="_blank"
          rel="noopener noreferrer"
          class="d-btn d-btn-ghost min-h-11 gap-1 px-3 text-sm font-medium text-slate-500 dark:text-slate-400"
        >
          {{ t('learn-more') }}
          <IconExternal class="h-3.5 w-3.5" aria-hidden="true" />
          <span class="sr-only">({{ t('open-in-new-tab') }})</span>
        </a>
      </template>
    </component>
  </section>
</template>

<style scoped>
@media (max-width: 650px) {
  .channel-introduction :deep(.cr-capgo-node) {
    top: 30%;
  }

  .channel-introduction :deep(.cr-capgo-state) {
    top: 51%;
    right: 1rem;
    left: 1rem;
    width: auto;
    max-width: none;
    transform: none;
  }

  .channel-introduction :deep(.cr-channel-card) {
    grid-template-columns: 1fr;
    gap: 0.3rem;
    padding: 0.35rem;
  }

  .channel-introduction :deep(.cr-channel-icon) {
    width: 1.5rem;
    height: 1.5rem;
  }

  .channel-introduction :deep(.csa-capgo-state) {
    top: 15.4rem;
    right: 1rem;
    left: 1rem;
    max-width: none;
    font-size: 0.62rem;
  }

  .channel-introduction :deep(.csa-channels-label) {
    top: 18.6rem;
  }

  .channel-introduction :deep(.csa-routing-channel-node) {
    top: 20rem;
  }

  .channel-introduction :deep(.csa-routing-channel-card) {
    grid-template-columns: 1fr;
    justify-items: center;
    gap: 0.15rem;
    min-height: 0;
    padding: 0.25rem;
    text-align: center;
  }

  .channel-introduction :deep(.csa-routing-channel-icon) {
    width: 1.5rem;
    height: 1.5rem;
  }
}
</style>
