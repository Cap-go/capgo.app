<script setup lang="ts">
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '~/utils/onboardingChannelAnalytics'
import ChannelConsoleAssignMockup from './ChannelConsoleAssignMockup.vue'

const emit = defineEmits<{
  analytics: [event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties]
  back: []
  continue: []
}>()

function forwardAnalytics(event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) {
  emit('analytics', event, properties)
}
</script>

<template>
  <ChannelConsoleAssignMockup
    embedded
    @analytics="forwardAnalytics"
    @back="emit('back')"
    @continue="emit('continue')"
  />
</template>
