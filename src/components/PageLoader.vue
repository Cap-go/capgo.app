<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CapgoLoader from '~/components/CapgoLoader.vue'

const props = withDefaults(defineProps<{
  label?: string
  size?: string
}>(), {
  label: '',
  size: 'w-16 h-16',
})

const { t } = useI18n()
const statusLabel = computed(() => props.label || t('loading'))
</script>

<template>
  <output :aria-label="statusLabel" aria-live="polite" class="flex min-h-[calc(100dvh-8rem)] w-full flex-col items-center justify-center px-4 py-10 text-center">
    <CapgoLoader :size="size" />
    <p v-if="label" class="mt-4 text-sm font-medium text-gray-500 dark:text-gray-400">
      {{ label }}
    </p>
  </output>
</template>
