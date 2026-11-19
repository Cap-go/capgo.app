<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import AppPageNotFound from '~/components/dashboard/AppPageNotFound.vue'
import { useConsole } from '~/services/console'
import { useDisplayStore } from '~/stores/display'

const id = ref('')
const route = useRoute('/app/[app].channels')
const lastPath = ref('')
const isLoading = ref(false)
const capgo = useConsole()
const displayStore = useDisplayStore()
const app = ref<Database['public']['Tables']['apps']['Row']>()

async function loadAppInfo() {
  try {
    const { data: dataApp } = await capgo
      .from('apps')
      .select()
      .eq('app_id', id.value)
      .single()
    app.value = dataApp || app.value
  }
  catch (error) {
    console.error(error)
  }
}

async function refreshData() {
  isLoading.value = true
  try {
    await loadAppInfo()
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}

watchEffect(async () => {
  if (route.params.app && lastPath.value !== route.path) {
    lastPath.value = route.path
    id.value = route.params.app as string
    await refreshData()
    displayStore.NavTitle = ''
    displayStore.defaultBack = '/apps'
  }
})
</script>

<template>
  <div>
    <div v-if="app || isLoading">
      <div class="mt-0">
        <div class="w-full h-full px-0 pt-6 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
          <SectionIntro section="channels" hide-explanation />
          <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-sm md:rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10">
            <ChannelTable :app-id="id" />
          </div>
        </div>
      </div>
    </div>
    <AppPageNotFound v-else />
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
