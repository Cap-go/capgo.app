<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppPageFrame from '~/components/dashboard/AppPageFrame.vue'
import CiCdSetupGuide from '~/components/dashboard/CiCdSetupGuide.vue'
import { useAppPage } from '~/composables/useAppPage'
import { isCiPlatform, isCiProduct } from '~/utils/cicdSetupGuide'

const { t } = useI18n()
const route = useRoute('/app/[app].ci-cd')
const { app, isLoading } = useAppPage({
  routeName: '/app/[app].ci-cd',
  navTitle: t('cicd-guide-nav-title'),
})
// The setup checklists link here with the path the user was following.
const initialProduct = computed(() => isCiProduct(route.query.product) ? route.query.product : undefined)
const initialPlatform = computed(() => isCiPlatform(route.query.platform) ? route.query.platform : undefined)
</script>

<template>
  <AppPageFrame :found="!!app" :loading="isLoading">
    <CiCdSetupGuide
      v-if="app"
      :key="`${app.app_id}:${app.owner_org}`"
      :app-id="app.app_id"
      :owner-org-id="app.owner_org"
      :initial-product="initialProduct"
      :initial-platform="initialPlatform"
    />
  </AppPageFrame>
</template>
