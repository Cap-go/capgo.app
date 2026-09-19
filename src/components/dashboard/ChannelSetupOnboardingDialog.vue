<script setup lang="ts">
import type { OnboardingChannelEvent, OnboardingChannelEventProperties, OnboardingChannelStage } from '~/utils/onboardingChannelAnalytics'
import { useScrollLock } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowLeft from '~icons/lucide/arrow-left'
import { withOnboardingChannelOrigin } from '~/utils/onboardingChannelAnalytics'
import ChannelConsoleAssignOnboarding from './ChannelConsoleAssignOnboarding.vue'
import ChannelCreateOnboarding from './ChannelCreateOnboarding.vue'
import ChannelDefaultRoutingOnboarding from './ChannelDefaultRoutingOnboarding.vue'
import ChannelSelfAssignOnboarding from './ChannelSelfAssignOnboarding.vue'

defineProps<{ appId: string }>()

const emit = defineEmits<{
  analytics: [event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties]
  close: []
  complete: []
}>()

const { t } = useI18n()
const titleId = useId()
const dialog = ref<HTMLDialogElement | null>(null)
const channelCreate = ref<InstanceType<typeof ChannelCreateOnboarding> | null>(null)
const submitting = computed(() => channelCreate.value?.isSubmitting ?? false)
const scrollLocked = useScrollLock(document.body)
const stage = ref<OnboardingChannelStage>('channel-routing')
let exiting = false

function track(event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) {
  // Keep the origin attached even to animation events emitted during unmount.
  emit('analytics', event, withOnboardingChannelOrigin(properties, 'todo_list'))
}

function transition(nextStage: OnboardingChannelStage, direction: 'backward' | 'forward') {
  track(direction === 'forward' ? 'onboarding_channel_stage_continued' : 'onboarding_channel_stage_backed', {
    channel_stage: stage.value,
    navigation_direction: direction,
    next_channel_stage: nextStage,
  })
  stage.value = nextStage
  dialog.value?.scrollTo({ top: 0 })
}

function exit(action: 'closed' | 'completed') {
  if (submitting.value || exiting)
    return
  exiting = true
  if (action === 'completed') {
    track('onboarding_channel_stage_continued', {
      channel_stage: stage.value,
      navigation_direction: 'forward',
      next_channel_stage: 'cli',
    })
  }
  track('onboarding_channel_flow_closed', {
    channel_stage: stage.value,
    flow_exit_action: action,
  })
  if (action === 'completed')
    emit('complete')
  else
    emit('close')
}

onMounted(() => {
  dialog.value?.showModal()
  scrollLocked.value = true
  track('onboarding_channel_flow_opened', { channel_stage: stage.value })
})

onBeforeUnmount(() => {
  dialog.value?.close()
  scrollLocked.value = false
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      :aria-labelledby="titleId"
      class="channel-setup-dialog m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-[1080px] overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-950 shadow-xl backdrop:bg-black/50 sm:p-6 dark:border-white/15 dark:bg-slate-950 dark:text-white"
      data-test="setup-checklist-channel-dialog"
      @cancel.prevent="exit('closed')"
    >
      <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 :id="titleId" class="text-lg font-semibold">
          {{ t('setup-checklist-step-add_channel') }}
        </h2>
        <button type="button" class="d-btn d-btn-ghost min-h-11 text-sm" :disabled="submitting" data-test="setup-checklist-channel-close" @click="exit('closed')">
          <IconArrowLeft class="h-4 w-4" aria-hidden="true" />
          {{ t('setup-checklist-return-checklist') }}
        </button>
      </header>

      <ChannelDefaultRoutingOnboarding
        v-if="stage === 'channel-routing'"
        @analytics="track"
        @continue="transition('channel-self-assign', 'forward')"
      />
      <ChannelSelfAssignOnboarding
        v-else-if="stage === 'channel-self-assign'"
        @analytics="track"
        @back="transition('channel-routing', 'backward')"
        @continue="transition('channel-console-assign', 'forward')"
      />
      <ChannelConsoleAssignOnboarding
        v-else-if="stage === 'channel-console-assign'"
        @analytics="track"
        @back="transition('channel-self-assign', 'backward')"
        @continue="transition('channel-create', 'forward')"
      />
      <template v-else>
        <button type="button" class="d-btn d-btn-ghost mb-3 min-h-11 text-sm" :disabled="submitting" data-test="setup-checklist-channel-back" @click="transition('channel-console-assign', 'backward')">
          <IconArrowLeft class="h-4 w-4" aria-hidden="true" />
          {{ t('button-back') }}
        </button>
        <ChannelCreateOnboarding ref="channelCreate" :app-id="appId" @analytics="track" @continue="exit('completed')" />
      </template>
    </dialog>
  </Teleport>
</template>

<style scoped>
@media (max-width: 650px) {
  .channel-setup-dialog :deep(.cr-page-embedded) {
    padding: 0;
  }

  .channel-setup-dialog :deep(.cr-capgo-node) {
    top: 30%;
  }

  .channel-setup-dialog :deep(.cr-capgo-state) {
    top: 51%;
    right: 1rem;
    left: 1rem;
    width: auto;
    max-width: none;
    transform: none;
  }

  .channel-setup-dialog :deep(.cr-channel-card) {
    grid-template-columns: 1fr;
    gap: 0.3rem;
    padding: 0.35rem;
  }

  .channel-setup-dialog :deep(.cr-channel-icon) {
    width: 1.5rem;
    height: 1.5rem;
  }

  .channel-setup-dialog :deep(.csa-capgo-state) {
    top: 15.4rem;
    right: 1rem;
    left: 1rem;
    max-width: none;
    font-size: 0.62rem;
  }

  .channel-setup-dialog :deep(.csa-channels-label) {
    top: 18.6rem;
  }

  .channel-setup-dialog :deep(.csa-routing-channel-node) {
    top: 20rem;
  }

  .channel-setup-dialog :deep(.csa-routing-channel-card) {
    grid-template-columns: 1fr;
    justify-items: center;
    gap: 0.15rem;
    min-height: 0;
    padding: 0.25rem;
    text-align: center;
  }

  .channel-setup-dialog :deep(.csa-routing-channel-icon) {
    width: 1.5rem;
    height: 1.5rem;
  }
}
</style>
