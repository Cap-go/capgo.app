<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { compareServingRegions, parseServingPolicy } from '../../../supabase/functions/_backend/plugin_runtime/utils/servingRegions'

const props = defineProps<{ disabled: boolean, appId: string }>()
const regions = defineModel<string[]>('regions', { required: true })
const mode = defineModel<string>('mode', { required: true })
const { t } = useI18n()
const options = ['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME']
const verification = ref<'unknown' | 'active' | 'pending' | 'unavailable'>('unknown')
let checkGeneration = 0
watch([regions, mode, () => props.appId], () => {
  checkGeneration++
  verification.value = 'unknown'
}, { deep: true, flush: 'sync' })
async function checkActivation() {
  const generation = ++checkGeneration
  const appId = props.appId
  verification.value = 'unknown'
  try {
    const url = new URL(encodeURIComponent(appId), import.meta.env.VITE_SERVING_POLICY_URL)
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok)
      throw new Error('Unavailable')
    const doc: unknown = await response.json()
    if (generation !== checkGeneration)
      return
    if (!doc || typeof doc !== 'object' || !('active' in doc) || !('app_id' in doc) || doc.app_id !== appId)
      throw new Error('Invalid rollout status')
    if (doc.active === false) {
      verification.value = 'pending'
      return
    }
    if (doc.active !== true || !('policy' in doc)
      || !doc.policy || typeof doc.policy !== 'object' || !('regions' in doc.policy) || !('mode' in doc.policy)) {
      throw new Error('Invalid policy')
    }
    const published = parseServingPolicy(doc.policy.regions, doc.policy.mode)
    verification.value = published.mode === mode.value
      && JSON.stringify([...published.regions].sort(compareServingRegions)) === JSON.stringify([...regions.value].sort(compareServingRegions))
      ? 'active'
      : 'pending'
  }
  catch {
    if (generation === checkGeneration)
      verification.value = 'unavailable'
  }
}
const empty = computed(() => regions.value.length === 0)
</script>

<template>
  <fieldset class="p-4 space-y-4 border rounded-lg border-slate-200 dark:border-slate-700" :disabled="props.disabled" data-test="serving-regions">
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
    <p class="text-sm text-neutral-600 dark:text-neutral-400">
      {{ t('serving-region-limits') }}
    </p>
    <button type="button" class="d-btn d-btn-sm d-btn-outline" @click="checkActivation">
      {{ t('serving-region-check') }}
    </button>
    <output class="block">
      {{ t(`serving-region-status-${verification}`) }}
    </output>
    <p class="text-sm text-amber-700 dark:text-amber-400" data-test="serving-region-activation">
      {{ t('serving-region-activation') }}
    </p>
  </fieldset>
</template>
