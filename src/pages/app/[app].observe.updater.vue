<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute('/app/[app].observe.updater')
const router = useRouter()

watchEffect(() => {
  const app = route.params.app
  if (!app)
    return
  const segment = typeof app === 'string' ? app : app[0]
  void router.replace({
    path: `/app/${segment}/observe/update`,
    query: route.query,
  })
})
</script>

<template>
  <PageLoader />
</template>

<route lang="yaml">
meta:
  layout: app
</route>
