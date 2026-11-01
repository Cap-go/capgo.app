<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import EmptyState from '~/components/EmptyState.vue'

const { t } = useI18n()
const router = useRouter()
</script>

<template>
  <EmptyState
    :icon="IconAlertCircle"
    icon-class="text-red-500"
    :title="t('app-not-found')"
    :description="t('app-not-found-description')"
  >
    <template #action>
      <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push('/apps')">
        {{ t('back-to-apps') }}
      </button>
    </template>
  </EmptyState>
</template>
