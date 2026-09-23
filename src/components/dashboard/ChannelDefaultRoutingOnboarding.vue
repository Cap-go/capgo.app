<script setup lang="ts">
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '~/utils/onboardingChannelAnalytics'
import ChannelDefaultRoutingMockup from './ChannelDefaultRoutingMockup.vue'

const emit = defineEmits<{
  analytics: [event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties]
  continue: []
}>()

function forwardAnalytics(event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) {
  emit('analytics', event, properties)
}
</script>

<template>
  <ChannelDefaultRoutingMockup embedded @analytics="forwardAnalytics" @continue="emit('continue')" />
</template>
