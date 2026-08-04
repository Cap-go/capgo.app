<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'

const { t } = useI18n()
const router = useRouter()
</script>

<template>
  <div class="flex flex-col justify-center items-center min-h-[50vh]">
    <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
    <h2 class="text-xl font-semibold text-foreground">
      {{ t('app-not-found') }}
    </h2>
    <p class="mt-2 text-muted-foreground">
      {{ t('app-not-found-description') }}
    </p>
    <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push('/apps')">
      {{ t('back-to-apps') }}
    </button>
  </div>
</template>
