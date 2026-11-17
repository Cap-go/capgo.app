<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import EmptyState from '~/components/EmptyState.vue'
import { useChannelRecord } from '~/composables/useChannelRecord'
import { useConsole } from '~/services/console'
import { useDisplayStore } from '~/stores/display'

interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
}

const route = useRoute('/app/[app].channel.[channel].history')
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()
const capgo = useConsole()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
// Cached row first, then a background refresh; stale reads never apply (see useChannelRecord).
const { channel, load: loadChannel, beginNavigation } = useChannelRecord<Database['public']['Tables']['channels']['Row'] & Channel>({
  read: async (channelId) => {
    const { data, error } = await capgo
      .from('channels')
      .select(`
          id,
          name,
          public,
          owner_org,
          version:app_versions!channels_version_fkey(
            id,
            name,
            app_id,
            created_at,
            min_update_version,
            storage_provider,
            link,
            comment
          ),
          created_at,
          app_id,
          allow_emulator,
          allow_device,
          allow_dev,
          allow_prod,
          allow_device_self_set,
          disable_auto_update_under_native,
          disable_auto_update,
          ios,
          android,
          updated_at
        `)
      .eq('id', channelId)
      .single()
    if (error) {
      console.error('no channel', error)
      return null
    }
    return data
  },
})

async function getChannel(force = false) {
  await loadChannel(id.value, force)
}

// Load on navigation only: a watchEffect would also track the cached store
// channel read inside getChannel and refetch every time the refresh stores it.
watch(() => route.path, async () => {
  if (route.path.includes('/channel/') && route.path.includes('/history')) {
    const isCurrent = beginNavigation()
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.channel as string)
    await getChannel()
    if (!isCurrent())
      return
    loading.value = false
    if (!channel.value?.name)
      displayStore.NavTitle = t('channel')
    displayStore.defaultBack = `/app/${route.params.app}/channels`
  }
}, { immediate: true })
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="channel">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-sm md:rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10">
          <ChannelHistoryTable
            :channel-id="id"
            :app-id="channel.app_id"
          />
        </div>
      </div>
    </div>
    <EmptyState
      v-else
      :icon="IconAlertCircle"
      icon-class="text-red-500"
      :title="t('channel-not-found')"
      :description="t('channel-not-found-description')"
    >
      <template #action>
        <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/channels`)">
          {{ t('back-to-channels') }}
        </button>
      </template>
    </EmptyState>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
