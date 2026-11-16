<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseServingPolicy } from '../../../supabase/functions/_backend/plugin_runtime/utils/servingRegions'

const props = defineProps<{ disabled: boolean, appId: string }>()
const regions = defineModel<string[]>('regions', { required: true })
const mode = defineModel<string>('mode', { required: true })
const { t } = useI18n()
const options = ['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME']
const verification = ref<'unknown' | 'active' | 'pending' | 'unavailable'>('unknown')
watch([regions, mode], () => {
  verification.value = 'unknown'
}, { deep: true })
async function checkActivation() {
  try {
    const response = await fetch(`https://plugin.eu.capgo.app/serving_policy/${encodeURIComponent(props.appId)}`, { cache: 'no-store' })
    if (!response.ok)
      throw new Error('Unavailable')
    const doc = await response.json()
    if (!doc || typeof doc !== 'object' || !('active' in doc) || !('app_id' in doc) || doc.app_id !== props.appId)
      throw new Error('Invalid rollout status')
    if (doc.active === false) {
      verification.value = 'pending'
      return
    }
    if (!doc || doc.active !== true || typeof doc !== 'object' || !('app_id' in doc) || doc.app_id !== props.appId || !('policy' in doc)
      || !doc.policy || typeof doc.policy !== 'object' || !('regions' in doc.policy) || !('mode' in doc.policy)) {
      throw new Error('Invalid policy')
    }
    const published = parseServingPolicy(doc.policy.regions, doc.policy.mode)
    verification.value = published.mode === mode.value
      && JSON.stringify([...published.regions].sort()) === JSON.stringify([...regions.value].sort())
      ? 'active'
      : 'pending'
  }
  catch {
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
        <input v-model="regions" type="checkbox" :value="region" class="checkbox checkbox-sm" :name="`serving-region-${region}`">
        {{ t(`serving-region-${region}`) }}
      </label>
    </div>
    <p v-if="empty" role="alert" class="text-sm text-red-600">
      {{ t('serving-regions-required') }}
    </p>
    <label class="block text-sm">
      <span class="block mb-2 font-medium">{{ t('serving-region-outside') }}</span>
      <select v-model="mode" name="serving_region_mode" class="w-full select select-bordered" :aria-label="t('serving-region-outside')">
        <option value="route">{{ t('serving-region-route') }}</option>
        <option value="block">{{ t('serving-region-block') }}</option>
      </select>
    </label>
    <p class="text-sm text-neutral-600 dark:text-neutral-400">
      {{ t('serving-region-limits') }}
    </p>
    <button type="button" class="btn btn-sm btn-outline" @click="checkActivation">
      {{ t('serving-region-check') }}
    </button>
    <p role="status">
      {{ t(`serving-region-status-${verification}`) }}
    </p>
    <p class="text-sm text-amber-700 dark:text-amber-400" data-test="serving-region-activation">
      {{ t('serving-region-activation') }}
    </p>
  </fieldset>
</template>
