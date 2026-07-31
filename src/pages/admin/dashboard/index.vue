<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

onMounted(() => {
  void router.replace('/admin/dashboard/users')
})
</script>

<template>
  <div />
</template>
