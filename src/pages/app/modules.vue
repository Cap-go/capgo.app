<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconNext from '~icons/ic/round-keyboard-arrow-right'
import { useDisplayStore } from '~/stores/display'

const { t } = useI18n()
const displayStore = useDisplayStore()

const dependencies = JSON.parse((import.meta.env.package_dependencies as string) || '{}')
interface Module {
  name: string
  version: string
  url: string
}
const modules = ref([] as Module[])
Object.keys(dependencies).forEach((dep) => {
  // console.log('dep', dep)
  if (dep.includes('capacitor')) {
    modules.value.push({
      name: dep,
      version: dependencies[dep],
      url: `https://www.npmjs.com/package/${dep}`,
    })
  }
})
function openLink(url?: string) {
  if (url)
    window.open(url, '_blank')
}
// console.log('modules', modules.value)
displayStore.NavTitle = t('module-heading')
displayStore.defaultBack = '/apps'
</script>

<template>
  <div>
    <div class="flex overflow-y-auto flex-col bg-white shadow-lg md:mx-auto md:mt-5 md:w-2/3 md:rounded-lg md:border border-slate-300 dark:border-slate-900 dark:bg-slate-800">
      <dl class="divide-y divide-slate-200 dark:divide-slate-500">
        <InfoRow :label="t('discover-module-in-a')" :is-link="true" @click="openLink('https://github.com/riderx/awesome-capacitor')">
          <button type="button" class="ml-auto w-7 h-7 bg-transparent">
            <IconNext />
          </button>
        </InfoRow>
        <InfoRow :label="t('available-in-the-san')" />
        <InfoRow v-for="(module, index) in modules" :key="index" :label="`${module.name}@${module.version}`" :is-link="true" @click="openLink(module.url)">
          <button type="button" class="ml-auto w-7 h-7 bg-transparent">
            <IconNext />
          </button>
        </InfoRow>
      </dl>
    </div>
  </div>
</template>
