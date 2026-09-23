<script setup lang="ts">
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '~/utils/onboardingChannelAnalytics'
import ChannelSelfAssignMockup from './ChannelSelfAssignMockup.vue'

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
  <ChannelSelfAssignMockup
    embedded
    @analytics="forwardAnalytics"
    @back="emit('back')"
    @continue="emit('continue')"
  />
</template>
