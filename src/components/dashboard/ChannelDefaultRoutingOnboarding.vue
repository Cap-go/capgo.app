<script setup lang="ts">
import ChannelDefaultRoutingMockup from './ChannelDefaultRoutingMockup.vue'

const emit = defineEmits<{
  continue: []
}>()
</script>

<template>
  <ChannelDefaultRoutingMockup embedded @continue="emit('continue')" />
</template>
