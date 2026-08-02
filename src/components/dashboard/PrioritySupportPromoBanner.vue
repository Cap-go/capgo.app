<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconGithub from '~icons/lucide/github'
import { pushEvent } from '~/services/posthog'
import { isPrioritySupportEligible, isPrioritySupportTrial, resolvePrioritySupportEligibility } from '~/services/prioritySupportPromo'
import { getLocalConfig } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{ appId: string, active: boolean, assignedVariant: 'support' | 'builder' }>()
const emit = defineEmits<{ eligibility: [eligible: boolean], ready: [ready: boolean] }>()

const { t } = useI18n()
const config = getLocalConfig()
const router = useRouter()
const organizationStore = useOrganizationStore()
const open = ref(false)
const presentationLoaded = ref(false)
const PrioritySupportPresentationModal = defineAsyncComponent(() => import('./PrioritySupportPresentationModal.vue'))

const organization = computed(() => organizationStore.getOrgByAppId(props.appId))
const isEligible = computed(() => isPrioritySupportEligible(organization.value))
const isTrial = computed(() => isPrioritySupportTrial(organization.value))
const subtitle = computed(() => t(isTrial.value ? 'priority-support-promo-trial-subtitle' : 'priority-support-promo-paying-subtitle'))
let shownTracked = false
let eligibilityReady = false
let eligibilityRequest = 0

function track(event: string) {
  pushEvent(event, config.supaHost, {
    app_id: props.appId,
    support_tier: isTrial.value ? 'trial' : 'paying',
    assigned_variant: props.assignedVariant,
    selection_reason: props.assignedVariant === 'support' ? 'assigned' : 'fallback',
  })
}

function openModal() {
  presentationLoaded.value = true
  open.value = true
  track('priority_support_promo_banner_clicked')
}

function linkGithub() {
  open.value = false
  router.push({ path: '/settings/account', query: { connect: 'github' } })
}

watch(isEligible, (eligible) => {
  if (eligibilityReady)
    emit('eligibility', eligible)
})
watch(
  () => props.appId,
  async () => {
    const request = ++eligibilityRequest
    eligibilityReady = false
    emit('eligibility', false)
    emit('ready', false)
    const eligible = await resolvePrioritySupportEligibility(
      () => organizationStore.awaitInitialLoad(),
      () => organization.value,
      error => console.error('[PrioritySupportPromoBanner] eligibility check failed', error),
    )
    if (request === eligibilityRequest) {
      eligibilityReady = true
      emit('eligibility', eligible)
      emit('ready', true)
    }
  },
  { immediate: true },
)
watch(
  () => [props.active, isEligible.value] as const,
  ([active, eligible]) => {
    if (active && eligible && !shownTracked) {
      shownTracked = true
      track('priority_support_promo_banner_shown')
    }
    else if (!active) {
      shownTracked = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <div>
    <button
      v-if="active && isEligible"
      type="button"
      class="priority-support-banner animate-fade-in mb-4 flex w-full cursor-pointer flex-col gap-4 rounded-lg border px-5 py-3 text-left shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
      @click="openModal"
    >
      <div class="flex items-center gap-3">
        <div class="priority-support-mark" aria-hidden="true">
          <IconGithub class="size-5" />
        </div>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-900 dark:text-slate-50">
            {{ t('priority-support-promo-title') }}
          </div>
          <div class="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
            {{ subtitle }}
          </div>
        </div>
      </div>

      <span class="priority-support-cta inline-flex flex-shrink-0 items-center justify-center whitespace-nowrap rounded-md px-5 py-2 text-sm font-semibold transition-colors">
        {{ t('priority-support-promo-cta') }} →
      </span>
    </button>

    <PrioritySupportPresentationModal
      v-if="presentationLoaded"
      :open="open"
      :support-tier="isTrial ? 'trial' : 'paying'"
      @close="open = false"
      @link-github="linkGithub"
    />
  </div>
</template>

<style scoped>
.priority-support-banner {
  border-color: rgb(203 213 225 / 0.9);
  background:
    linear-gradient(100deg, rgb(248 250 252 / 0.98), rgb(241 245 249 / 0.78)),
    radial-gradient(circle at 8% 50%, rgb(148 163 184 / 0.16), transparent 34%);
}

.priority-support-banner:focus-visible {
  outline: 3px solid #0878c9;
  outline-offset: 3px;
}

.priority-support-mark {
  display: grid;
  width: 46px;
  height: 32px;
  flex: none;
  place-items: center;
  border: 1px solid rgb(148 163 184 / 0.65);
  border-radius: 10px;
  color: #f8fafc;
  background: linear-gradient(145deg, #334155, #0f172a);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.15),
    0 2px 4px rgb(15 23 42 / 0.16);
}

.priority-support-cta {
  color: #f8fafc;
  background: #1e293b;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.12);
}

.priority-support-banner:hover .priority-support-cta {
  background: #334155;
}

.dark .priority-support-banner {
  border-color: rgb(71 85 105 / 0.88);
  background:
    linear-gradient(105deg, rgb(2 6 23 / 0.92), rgb(15 23 42 / 0.82)),
    radial-gradient(circle at 8% 50%, rgb(30 58 138 / 0.24), transparent 38%);
}

.dark .priority-support-banner:focus-visible {
  outline-color: #38bdf8;
}

.dark .priority-support-mark {
  border-color: rgb(100 116 139 / 0.85);
  background: linear-gradient(145deg, #334155, #111827);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.1),
    0 0 18px rgb(30 64 175 / 0.14);
}

.dark .priority-support-cta {
  background: #e2e8f0;
  color: #0f172a;
}

.dark .priority-support-banner:hover .priority-support-cta {
  background: #f8fafc;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-fade-in {
  animation: fade-in 0.3s ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .animate-fade-in {
    animation: none;
  }
}
</style>
