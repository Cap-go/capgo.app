<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import LiveReleaseDashboard from '~/components/dashboard/LiveReleaseDashboard.vue'
import EmptyState from '~/components/EmptyState.vue'
import { useChannelRecord } from '~/composables/useChannelRecord'
import { useDisplayStore } from '~/stores/display'

// Same screen as Observe > Live release, locked to this channel.
interface Channel {
  version: Database['public']['Tables']['app_versions']['Row']
}

const route = useRoute('/app/[app].channel.[channel].statistics')
const router = useRouter()
const displayStore = useDisplayStore()
const { t } = useI18n()

const packageId = ref<string>('')
const id = ref<number>(0)
const loading = ref(true)
// Cached row first, then a background refresh; stale reads never apply (see useChannelRecord).
const { channel, load: loadChannel, beginNavigation } = useChannelRecord<Database['public']['Tables']['channels']['Row'] & Channel>()

async function getChannel(force = false) {
  await loadChannel(id.value, force)
}

// Load on navigation only: a watchEffect would also track the cached store
// channel read inside getChannel and refetch every time the refresh stores it.
watch(() => route.path, async () => {
  if (route.path.includes('/channel/') && route.path.includes('/statistics')) {
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
    <div v-else-if="channel" class="w-full h-full px-4 pt-4 mx-auto mb-8 sm:px-6 lg:px-8 max-w-9xl max-h-fit">
      <LiveReleaseDashboard :app-id="packageId" :channel-id="id" />
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
