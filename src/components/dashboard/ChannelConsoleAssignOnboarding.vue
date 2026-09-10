<script setup lang="ts">
import ChannelConsoleAssignMockup from './ChannelConsoleAssignMockup.vue'

const emit = defineEmits<{
  back: []
  continue: []
}>()
</script>

<template>
  <ChannelConsoleAssignMockup
    embedded
    @back="emit('back')"
    @continue="emit('continue')"
  />
</template>
