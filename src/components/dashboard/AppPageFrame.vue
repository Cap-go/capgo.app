<script setup lang="ts">
import AppPageNotFound from '~/components/dashboard/AppPageNotFound.vue'

defineProps<{
  found: boolean
  loading: boolean
  card?: boolean
}>()
</script>

<template>
  <div>
    <div v-if="found || loading">
      <div class="mt-0 md:mt-8">
        <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
          <div
            v-if="card"
            class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900"
          >
            <slot />
          </div>
          <slot v-else />
        </div>
      </div>
    </div>
    <AppPageNotFound v-else />
  </div>
</template>
