<script setup lang="ts">
import { availableLocales, i18n, languages } from '~/modules/i18n'
import { changeLanguage, getEmoji } from '~/services/i18n'

const dropdown = useTemplateRef('dropdown')
onClickOutside(dropdown, () => closeDropdown())
function closeDropdown() {
  if (dropdown.value) {
    dropdown.value.removeAttribute('open')
  }
}
</script>

<template>
  <div ref="dropdown" class="d-dropdown">
    <button type="button" tabindex="0" class="m-1 border-gray-300 dark:border-gray-600 d-btn d-btn-outline d-btn-sm">
      {{ getEmoji(i18n.global.locale.value) }} {{ languages[i18n.global.locale.value as keyof typeof languages] }} <svg class="ml-2 w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
    </button>
    <ul tabindex="0" class="p-2 w-52 bg-white shadow d-dropdown-content d-menu rounded-box z-1 dark:bg-base-200">
      <li v-for="locale in availableLocales" :id="locale" :key="locale" class="cursor-pointer" @click="changeLanguage(locale)">
        <span class="block py-2 px-4 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-gray-600 dark:hover:text-white" :class="{ 'bg-gray-100 text-gray-600 dark:text-gray-300 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-900': locale === i18n.global.locale.value }">{{ getEmoji(locale) }} {{ languages[locale as keyof typeof languages] }}</span>
      </li>
    </ul>
  </div>
</template>
