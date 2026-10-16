<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconApple from '~icons/simple-icons/apple'

defineProps<{ disabled?: boolean, loading?: boolean }>()
defineEmits<{ click: [] }>()
const { t } = useI18n()
</script>

<template>
  <button
    type="button"
    data-test="apple-sign-in"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : 'false'"
    class="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-xl border border-black bg-black px-4 py-3 text-base font-semibold text-white transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-black disabled:pointer-events-none disabled:opacity-60 dark:border-white dark:bg-white dark:text-black dark:focus-visible:outline-white"
    @click="$emit('click')"
  >
    <Spinner v-if="loading" size="w-5 h-5" color="fill-current" />
    <IconApple v-else class="h-5 w-5" aria-hidden="true" />
    <span>{{ t('sign-in-with-apple') }}</span>
  </button>
</template>
