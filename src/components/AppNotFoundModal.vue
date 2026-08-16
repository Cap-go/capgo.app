<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'

const { t } = useI18n()
const router = useRouter()

function goToApps() {
  router.push('/apps')
}
</script>

<template>
  <div class="flex absolute inset-0 z-10 flex-col justify-center items-center bg-white/60 dark:bg-gray-900/60">
    <div class="p-8 text-center bg-white rounded-xl border shadow-xl dark:bg-gray-800 border-red-200 dark:border-red-700">
      <div class="flex justify-center mb-4">
        <div class="flex justify-center items-center w-16 h-16 bg-red-100 rounded-full dark:bg-red-900/30">
          <IconAlertCircle class="w-8 h-8 text-red-500" />
        </div>
      </div>
      <h2 class="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
        {{ t('app-not-found') }}
      </h2>
      <p class="mb-6 max-w-sm text-gray-600 dark:text-gray-400">
        {{ t('app-not-found-description') }}
      </p>
      <button
        type="button"
        class="inline-flex gap-2 items-center px-6 py-3 text-white bg-primary rounded-lg transition-colors cursor-pointer hover:bg-primary/90 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none"
        @click="goToApps"
      >
        <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
        {{ t('back-to-apps') }}
      </button>
    </div>
  </div>
</template>
