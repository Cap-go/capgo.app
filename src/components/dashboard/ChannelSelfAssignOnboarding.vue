<script setup lang="ts">
import ChannelSelfAssignMockup from './ChannelSelfAssignMockup.vue'

const emit = defineEmits<{
  back: []
  continue: []
}>()
</script>

<template>
  <ChannelSelfAssignMockup
    embedded
    @back="emit('back')"
    @continue="emit('continue')"
  />
</template>
