<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { openSupport } from '~/services/support'

const { t } = useI18n()
</script>

<template>
  <div class="py-16 px-4 min-h-full sm:py-24 sm:px-6 md:grid md:place-items-center lg:px-8">
    <div class="mx-auto max-w-max">
      <main class="flex flex-col items-center text-center">
        <img src="/404.webp" alt="404" class="w-full max-w-[900px]">
        <div>
          <h1 class="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl">
            {{ t('page-not-found-title') }}
          </h1>
          <p class="mt-1 text-base text-gray-500">
            {{ t('page-not-found-description') }}
          </p>
          <div class="flex justify-center mt-10 space-x-3">
            <a href="/" class="inline-flex items-center py-2 px-4 text-sm font-medium text-white rounded-md border border-transparent focus:ring-2 focus:ring-offset-2 shadow-xs bg-cornflower-600 hover:bg-cornflower-700 focus:outline-hidden focus:ring-cornflower-500">
              {{ t('go-back-home') }}
            </a>
            <a href="#" class="inline-flex items-center py-2 px-4 text-sm font-medium rounded-md border border-transparent focus:ring-2 focus:ring-offset-2 text-cornflower-700 bg-cornflower-100 hover:bg-cornflower-200 focus:outline-hidden focus:ring-cornflower-500" @click="openSupport">
              {{ t('contact-support') }}
            </a>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>
