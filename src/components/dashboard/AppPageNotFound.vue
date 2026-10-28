<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'

const { t } = useI18n()
const router = useRouter()
</script>

<template>
  <div class="flex flex-col justify-center items-center min-h-[50vh]">
    <IconAlertCircle class="w-16 h-16 mb-4 text-red-500" />
    <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
      {{ t('app-not-found') }}
    </h2>
    <p class="mt-2 text-slate-500 dark:text-slate-400">
      {{ t('app-not-found-description') }}
    </p>
    <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push('/apps')">
      {{ t('back-to-apps') }}
    </button>
  </div>
</template>
