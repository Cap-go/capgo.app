<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import CiCdSetupGuide from '~/components/dashboard/CiCdSetupGuide.vue'
import { useAppPage } from '~/composables/useAppPage'
import { resolveCiGuideContext } from '~/utils/cicdSetupState'

const { t } = useI18n()
const route = useRoute('/app/[app].ci-cd')
const { app, isLoading } = useAppPage({
  routeName: '/app/[app].ci-cd',
  navTitle: t('cicd-guide-nav-title'),
})
// The setup checklists link here with the path the user was following.
const guideContext = computed(() => resolveCiGuideContext({
  onboarding: app.value?.onboarding,
  product: route.query.product,
  platform: route.query.platform,
}))
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <CiCdSetupGuide
      v-if="app"
      :key="`${app.app_id}:${app.owner_org}:${guideContext.product}:${guideContext.platform ?? ''}`"
      :app-id="app.app_id"
      :owner-org-id="app.owner_org"
      :initial-product="guideContext.product"
      :initial-platform="guideContext.platform"
    />
  </AppPageFrame>
</template>
