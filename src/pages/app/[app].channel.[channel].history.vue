<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { useSupabase } from '~/services/supabase'
import { useAppDetailStore } from '~/stores/appDetail'
import { useDisplayStore } from '~/stores/display'

interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
}

const route = useRoute('/app/[app].channel.[channel].history')
const router = useRouter()
const displayStore = useDisplayStore()
const appDetailStore = useAppDetailStore()
const { t } = useI18n()
const supabase = useSupabase()
const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
const channel = ref<Database['public']['Tables']['channels']['Row'] & Channel>()

async function getChannel() {
  if (!id.value)
    return

  // Check if we already have this channel in the store
  if (appDetailStore.currentChannelId === id.value && appDetailStore.currentChannel) {
    channel.value = appDetailStore.currentChannel as any
    if (channel.value?.name)
      displayStore.setChannelName(String(channel.value.id), channel.value.name)
    displayStore.NavTitle = channel.value?.name ?? t('channel')
    return
  }

  try {
    const { data, error } = await supabase
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
      .eq('id', id.value)
      .single()
    if (error) {
      console.error('no channel', error)
      return
    }

    channel.value = data as unknown as Database['public']['Tables']['channels']['Row'] & Channel

    // Store in appDetailStore
    appDetailStore.setChannel(id.value, channel.value)

    if (channel.value?.name)
      displayStore.setChannelName(String(channel.value.id), channel.value.name)
    displayStore.NavTitle = channel.value?.name ?? t('channel')
  }
  catch (error) {
    console.error(error)
  }
}

watchEffect(async () => {
  if (route.path.includes('/channel/') && route.path.includes('/history')) {
    loading.value = true
    packageId.value = route.params.app as string
    id.value = Number(route.params.channel as string)
    await getChannel()
    loading.value = false
    if (!channel.value?.name)
      displayStore.NavTitle = t('channel')
    displayStore.defaultBack = `/app/${route.params.app}/channels`
  }
})
</script>

<template>
  <div>
    <PageLoader v-if="loading" />
    <div v-else-if="channel">
      <div class="w-full h-full px-0 pt-0 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-lg md:rounded-lg dark:bg-gray-800 border-slate-300 dark:border-slate-900">
          <ChannelHistoryTable
            :channel-id="id"
            :app-id="channel.app_id"
          />
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('channel-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('channel-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="router.push(`/app/${packageId}/channels`)">
        {{ t('back-to-channels') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>
