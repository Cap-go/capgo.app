<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { computed, ref, watch } from 'vue'
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
const appRouteId = computed(() => {
  const appParam = (route.params as { app?: string | string[] }).app
  return Array.isArray(appParam) ? (appParam[0] ?? '') : String(appParam ?? '')
})

const id = ref('')
const isLoading = ref(true)
const app = ref<Database['public']['Tables']['apps']['Row']>()

watch(appRouteId, async (nextId) => {
  if (!nextId) {
    id.value = ''
    app.value = undefined
    isLoading.value = false
    return
  }

  id.value = nextId
  isLoading.value = true
  displayStore.NavTitle = t('security-updates-title')
  const { data, error } = await capgo.from('apps').select().eq('app_id', nextId).single()
  if (nextId !== appRouteId.value)
    return
  if (error) {
    app.value = undefined
  }
  else {
    app.value = data ?? undefined
  }
  isLoading.value = false
}, { immediate: true })
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
