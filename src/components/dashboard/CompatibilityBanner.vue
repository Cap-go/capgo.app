<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import { groupCompatibilityEvents } from '~/services/compatibilityEvents'
import { useSupabase } from '~/services/supabase'

const props = defineProps<{
  appId: string
}>()

const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()

const unresolvedCount = ref(0)

async function fetchUnresolvedCount() {
  if (!props.appId) {
    unresolvedCount.value = 0
    return
  }

  try {
    // Count occurrences, not raw rows: one channel change is many per-platform
    // rows. Group the unresolved rows the same way the history page does so the
    // banner count matches what the user sees there.
    const { data, error } = await supabase
      .from('compatibility_events')
      .select('id, platform, channel_id, current_version_id, previous_version_id, source, change_occurred_at, created_at, resolved_at')
      .eq('app_id', props.appId)
      .is('resolved_at', null)

    if (error) {
      console.error('[CompatibilityBanner] Error fetching unresolved count:', error)
      unresolvedCount.value = 0
      return
    }

    unresolvedCount.value = groupCompatibilityEvents(data ?? []).length
  }
  catch (error) {
    console.error('[CompatibilityBanner] Error fetching unresolved count:', error)
    unresolvedCount.value = 0
  }
}

function viewCompatibility() {
  router.push(`/app/${encodeURIComponent(props.appId)}/observe/compatibility`)
}

watch(() => props.appId, () => {
  fetchUnresolvedCount()
}, { immediate: true })
</script>

<template>
  <div
    v-if="unresolvedCount > 0"
    data-test="compatibility-banner"
    role="button"
    tabindex="0"
    class="mb-4 overflow-hidden transition-colors border rounded-lg cursor-pointer border-amber-200 bg-amber-50 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-amber-900/20 dark:border-amber-800 dark:hover:bg-amber-900/30"
    @click="viewCompatibility"
    @keydown.enter.prevent="viewCompatibility"
    @keydown.space.prevent="viewCompatibility"
  >
    <div class="flex items-center justify-between p-4">
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/50">
          <IconAlertTriangle class="w-5 h-5 text-amber-600 dark:text-amber-400" />
        </div>

        <div>
          <p class="font-semibold text-amber-900 dark:text-amber-100">
            {{ t('compatibility-events') }}
          </p>
          <p class="text-sm text-amber-700 dark:text-amber-300">
            {{ t('compatibility-unresolved-banner', { count: unresolvedCount }) }}
          </p>
        </div>
      </div>

      <button
        data-test="compatibility-banner-view"
        tabindex="-1"
        class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white transition-colors rounded-md bg-amber-600 hover:bg-amber-700 shrink-0"
        @click.stop="viewCompatibility"
      >
        {{ t('compatibility-view-details') }}
      </button>
    </div>
  </div>
</template>
