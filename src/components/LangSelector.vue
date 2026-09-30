<script setup lang="ts">
import IconCheck from '~icons/lucide/check'
import IconDown from '~icons/lucide/chevron-down'
import { availableLocales, i18n, languages } from '~/modules/i18n'
import { changeLanguage, getEmoji } from '~/services/i18n'

const props = withDefaults(defineProps<{
  placement?: 'top' | 'bottom'
}>(), {
  placement: 'top',
})

const dropdown = useTemplateRef('dropdown')
onClickOutside(dropdown, () => closeDropdown())
function closeDropdown() {
  if (dropdown.value) {
    dropdown.value.removeAttribute('open')
  }
  if (document.activeElement instanceof HTMLElement && dropdown.value?.contains(document.activeElement))
    document.activeElement.blur()
}

function selectLanguage(locale: string) {
  void changeLanguage(locale)
  closeDropdown()
}
</script>

<template>
  <div ref="dropdown" class="d-dropdown d-dropdown-center" :class="{ 'd-dropdown-top': props.placement === 'top' }">
    <button
      type="button"
      tabindex="0"
      class="inline-flex items-center gap-2 h-9 px-3 m-1 text-sm font-medium rounded-lg border border-slate-300 bg-white text-slate-700 cursor-pointer transition-colors duration-150 hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-700"
    >
      <span aria-hidden="true">{{ getEmoji(i18n.global.locale.value) }}</span>
      {{ languages[i18n.global.locale.value as keyof typeof languages] }}
      <IconDown class="size-4 text-slate-400" aria-hidden="true" />
    </button>
    <ul
      tabindex="0"
      class="d-dropdown-content z-20 w-56 max-h-72 overflow-y-auto overscroll-contain p-1 rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800"
      :class="props.placement === 'top' ? 'mb-1' : 'mt-1'"
    >
      <li
        v-for="locale in availableLocales"
        :id="locale"
        :key="locale"
      >
        <button
          type="button"
          :aria-current="locale === i18n.global.locale.value ? 'true' : undefined"
          class="flex w-full items-center gap-2.5 h-9 px-2.5 rounded-lg text-left text-sm cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-azure-500"
          :class="locale === i18n.global.locale.value
            ? 'bg-azure-500/10 font-medium text-slate-900 dark:text-white'
            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'"
          @click="selectLanguage(locale)"
        >
          <span aria-hidden="true">{{ getEmoji(locale) }}</span>
          <span class="flex-1 truncate">{{ languages[locale as keyof typeof languages] }}</span>
          <IconCheck v-if="locale === i18n.global.locale.value" class="size-4 shrink-0 text-azure-500" aria-hidden="true" />
        </button>
      </li>
    </ul>
  </div>
</template>
