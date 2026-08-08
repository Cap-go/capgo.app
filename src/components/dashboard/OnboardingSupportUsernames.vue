<script setup lang="ts">
import { computed, unref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import IconDiscord from '~icons/ic/round-discord'
import IconBadgeCheck from '~icons/lucide/badge-check'
import IconChevronRight from '~icons/lucide/chevron-right'
import IconGithub from '~icons/lucide/github'
import IconHeadset from '~icons/lucide/headset'
import IconSparkles from '~icons/lucide/sparkles'
import IconZap from '~icons/lucide/zap'
import GitHubProfileDialog from '~/components/dashboard/GitHubProfileDialog.vue'

const props = withDefaults(defineProps<{
  dialogId?: string
  /** New-user Capgo onboarding (app → organization), not additional-org create */
  isNewUserOnboarding?: boolean
  compact?: boolean
  hideIntro?: boolean
}>(), {
  dialogId: 'onboarding-github-profile',
  isNewUserOnboarding: false,
  compact: false,
  hideIntro: false,
})

const discordUsername = defineModel<string>('discordUsername', { required: true })

const { t } = useI18n()
const githubDialog = useTemplateRef<InstanceType<typeof GitHubProfileDialog>>('githubDialog')

const githubUsername = computed((): string => unref(githubDialog.value?.githubUsername) ?? '')

const supportBenefits = computed(() => [
  { icon: IconBadgeCheck, label: t('organization-onboarding-support-benefit-match') },
  { icon: IconZap, label: t('organization-onboarding-support-benefit-maker') },
  { icon: IconSparkles, label: t('organization-onboarding-support-benefit-trial') },
])

const helperText = computed(() => {
  if (props.isNewUserOnboarding)
    return t('organization-onboarding-support-usernames-helper-new-user')
  return t('organization-onboarding-support-usernames-helper')
})

function openGitHubProfileDialog() {
  githubDialog.value?.openGitHubProfileDialog()
}
</script>

<template>
  <section
    class="overflow-hidden rounded-2xl border border-primary-500/20 bg-linear-to-br from-primary-500/5 via-white to-slate-50 shadow-sm dark:border-primary-500/30 dark:from-primary-500/10 dark:via-slate-950/90 dark:to-slate-950"
    :class="{ 'shadow-none': compact }"
    aria-labelledby="onboarding-support-usernames-title"
  >
    <div class="space-y-4 p-4 sm:p-5">
      <div v-if="!hideIntro" class="flex items-start gap-3">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white shadow-sm shadow-primary-500/30">
          <IconHeadset class="h-5 w-5" aria-hidden="true" />
        </span>
        <div class="min-w-0">
          <p
            v-if="isNewUserOnboarding"
            class="text-xs font-medium uppercase tracking-wide text-primary-600 dark:text-primary-300"
          >
            {{ t('organization-onboarding-support-usernames-step') }}
          </p>
          <h3 id="onboarding-support-usernames-title" class="text-base font-semibold text-slate-950 dark:text-white" :class="{ 'mt-1': isNewUserOnboarding }">
            {{ t('organization-onboarding-support-usernames-title') }}
          </h3>
          <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ helperText }}
          </p>
        </div>
      </div>
      <h3 v-else id="onboarding-support-usernames-title" class="sr-only">
        {{ t('organization-onboarding-support-usernames-title') }}
      </h3>

      <ul class="flex flex-wrap gap-2" :aria-label="t('organization-onboarding-support-usernames-title')">
        <li
          v-for="benefit in supportBenefits"
          :key="benefit.label"
          class="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white/90 px-3 text-xs font-medium text-slate-700 dark:border-white/15 dark:bg-slate-900/80 dark:text-slate-200"
        >
          <component :is="benefit.icon" class="h-3.5 w-3.5 text-primary-500" aria-hidden="true" />
          <span>{{ benefit.label }}</span>
        </li>
      </ul>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/15 dark:bg-slate-950/80">
          <label for="onboarding-discord-username" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <IconDiscord class="h-4 w-4 text-primary-500" aria-hidden="true" />
            <span>{{ t('discord-username') }}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {{ t('optional') }}
            </span>
          </label>
          <div class="relative mt-2">
            <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400" aria-hidden="true">
              @
            </span>
            <input
              id="onboarding-discord-username"
              v-model="discordUsername"
              type="text"
              autocomplete="off"
              maxlength="32"
              :placeholder="t('discord-username')"
              aria-describedby="onboarding-discord-username-help"
              data-test="onboarding-discord-username"
              class="min-h-11 w-full rounded-xl border border-slate-300 bg-white py-2 pr-3 pl-8 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 sm:text-sm dark:border-white/20 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
            >
          </div>
          <p id="onboarding-discord-username-help" class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('discord-username-help') }}
          </p>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/15 dark:bg-slate-950/80">
          <label for="onboarding-github-username" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <IconGithub class="h-4 w-4 text-primary-500" aria-hidden="true" />
            <span>{{ t('github-username') }}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {{ t('optional') }}
            </span>
          </label>
          <button
            id="onboarding-github-username"
            type="button"
            class="mt-2 flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-left text-base text-slate-950 outline-none transition hover:border-primary-500/50 hover:bg-primary-500/5 focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/15 sm:text-sm dark:border-white/20 dark:bg-slate-950 dark:text-white dark:hover:border-primary-500/50 dark:hover:bg-primary-500/10 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-500/30"
            aria-describedby="onboarding-github-username-help"
            data-test="onboarding-github-username"
            @click="openGitHubProfileDialog"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2">
              <template v-if="githubUsername">
                <IconBadgeCheck class="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                <span class="truncate font-medium">{{ githubUsername }}</span>
                <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  {{ t('organization-onboarding-support-github-verified') }}
                </span>
              </template>
              <span v-else class="truncate text-slate-500 dark:text-slate-400">
                {{ t('organization-onboarding-support-github-cta') }}
              </span>
            </span>
            <IconChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          </button>
          <p id="onboarding-github-username-help" class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('github-username-help') }}
          </p>
        </div>
      </div>

      <p id="onboarding-support-usernames-help" class="text-xs leading-5 text-slate-500 dark:text-slate-400">
        {{ t('social-username-help') }}
      </p>
    </div>
  </section>

  <GitHubProfileDialog ref="githubDialog" :dialog-id="dialogId" />
</template>
