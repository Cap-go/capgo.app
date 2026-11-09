<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import SecurityUpdatesFeedPanel from '~/components/security/SecurityUpdatesFeedPanel.vue'
import { useConsole } from '~/services/console'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const route = useRoute()
const capgo = useConsole()
const displayStore = useDisplayStore()
const id = ref('')
const isLoading = ref(true)
const app = ref<Database['public']['Tables']['apps']['Row']>()

watchEffect(async () => {
  const appParam = (route.params as { app?: string | string[] }).app
  const nextId = Array.isArray(appParam) ? (appParam[0] ?? '') : String(appParam ?? '')
  if (!nextId || id.value === nextId)
    return

  id.value = nextId
  isLoading.value = true
  displayStore.NavTitle = t('security-updates-title')
  const { data } = await capgo.from('apps').select().eq('app_id', nextId).single()
  app.value = data ?? undefined
  isLoading.value = false
})
</script>

<template>
  <AppPageFrame card :found="!!app" :loading="isLoading">
    <SecurityUpdatesFeedPanel :app-id="id" />
  </AppPageFrame>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
