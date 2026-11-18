<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { z } from 'zod'
import { compareServingRegions, parseServingPolicy } from '../../../supabase/functions/_backend/plugin_runtime/utils/servingRegions'

const props = defineProps<{ disabled: boolean, appId: string, savedRegions: string[], savedMode: string }>()
const regions = defineModel<string[]>('regions', { required: true })
const mode = defineModel<string>('mode', { required: true })
const { t } = useI18n()
const options = ['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME']
const verification = ref<'checking' | 'active' | 'pending' | 'unavailable'>('checking')
const available = ref(false)
const retryDelays = [2000, 5000, 10000, 20000, 30000]
const statusResponse = z.discriminatedUnion('active', [
  z.object({ app_id: z.string(), active: z.literal(false) }),
  z.object({
    app_id: z.string(),
    active: z.literal(true),
    policy: z.object({ regions: z.array(z.string()), mode: z.enum(['route', 'block']) }),
  }),
])
const policyKey = (values: string[], value: string) => JSON.stringify([[...values].sort(compareServingRegions), value])
const unsaved = computed(() => policyKey(regions.value, mode.value) !== policyKey(props.savedRegions, props.savedMode))
const empty = computed(() => regions.value.length === 0)
let checkGeneration = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let cancelRequest: (() => void) | undefined

function cancelCheck() {
  clearTimeout(retryTimer)
  retryTimer = undefined
  cancelRequest?.()
  cancelRequest = undefined
}

async function checkSavedSettings(generation: number, attempt = 0) {
  const appId = props.appId
  const savedKey = policyKey(props.savedRegions, props.savedMode)
  const controller = new AbortController()
  const cancelled = Promise.withResolvers<never>()
  const cancel = () => {
    controller.abort()
    cancelled.reject(new Error('Status check cancelled'))
  }
  cancelRequest = cancel
  let timeout: ReturnType<typeof setTimeout> | undefined
  let retry = false
  try {
    const url = new URL(encodeURIComponent(appId), import.meta.env.VITE_SERVING_POLICY_URL)
    const response = await Promise.race([
      fetch(url, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
        if (!response.ok)
          throw new Error('Unavailable')
        return statusResponse.parse(await response.json())
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('Status check timed out'))
        }, 10000)
      }),
      cancelled.promise,
    ])
    if (generation !== checkGeneration)
      return
    if (response.app_id !== appId)
      throw new Error('Invalid app status')
    if (!response.active) {
      // Do not offer settings that the service cannot apply yet.
      available.value = false
      return
    }
    const published = parseServingPolicy(response.policy.regions, response.policy.mode)
    available.value = true
    verification.value = policyKey(published.regions, published.mode) === savedKey ? 'active' : 'pending'
    retry = verification.value === 'pending'
  }
  catch {
    if (generation === checkGeneration) {
      verification.value = 'unavailable'
      retry = true
    }
  }
  finally {
    clearTimeout(timeout)
    if (cancelRequest === cancel)
      cancelRequest = undefined
    if (generation === checkGeneration && retry && attempt < retryDelays.length) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void checkSavedSettings(generation, attempt + 1)
      }, retryDelays[attempt])
    }
  }
}

watch([() => props.appId, () => policyKey(props.savedRegions, props.savedMode)], (_, previous) => {
  const generation = ++checkGeneration
  cancelCheck()
  if (!previous || props.appId !== previous[0])
    available.value = false
  verification.value = 'checking'
  void checkSavedSettings(generation)
}, { immediate: true, flush: 'sync' })

onScopeDispose(() => {
  checkGeneration++
  cancelCheck()
})
</script>

<template>
  <fieldset v-if="available" class="p-4 space-y-4 border rounded-lg border-slate-200 dark:border-slate-700" :disabled="props.disabled" data-test="serving-regions">
    <legend class="px-1 text-sm font-semibold">
      {{ t('serving-regions') }}
    </legend>
    <p id="serving-region-scope" class="text-sm text-neutral-600 dark:text-neutral-400">
      {{ t('serving-regions-help') }}
    </p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-describedby="serving-region-scope">
      <label v-for="region in options" :key="region" class="flex items-center gap-2 text-sm">
        <input v-model="regions" type="checkbox" :value="region" class="d-checkbox d-checkbox-sm" :name="`serving-region-${region}`">
        {{ t(`serving-region-${region}`) }}
      </label>
    </div>
    <p v-if="empty" role="alert" class="text-sm text-red-600">
      {{ t('serving-regions-required') }}
    </p>
    <label class="block text-sm">
      <span class="block mb-2 font-medium">{{ t('serving-region-outside') }}</span>
      <select v-model="mode" name="serving_region_mode" class="w-full d-select d-select-bordered" :aria-label="t('serving-region-outside')">
        <option value="route">{{ t('serving-region-route') }}</option>
        <option value="block">{{ t('serving-region-block') }}</option>
      </select>
    </label>
    <output class="block text-sm" aria-live="polite">
      {{ t(unsaved ? 'serving-region-status-unsaved' : `serving-region-status-${verification}`) }}
    </output>
  </fieldset>
</template>
