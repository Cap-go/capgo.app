<script setup lang="ts">
import { CHINA_CONSOLE_URL, suggestChinaConsole } from '~/services/console'

const href = CHINA_CONSOLE_URL
</script>

<template>
  <div
    v-if="suggestChinaConsole"
    class="d-alert d-alert-warning mx-auto max-w-4xl rounded-none border-x-0 border-t-0"
    role="status"
  >
    <p class="text-sm">
      {{ $t('china-console-suggestion') }}
      <a class="d-link d-link-primary font-semibold" :href="href">{{ href }}</a>
    </p>
  </div>
</template>