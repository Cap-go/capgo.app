<script setup lang="ts">
/**
 * BuilderPromoBanner
 *
 * Per-app banner promoting Capgo Builder (native cloud builds). Clicking it
 * opens the BuilderPresentationModal (5-slide animated deck).
 *
 * Visibility: only shown for apps that have NO native build yet
 * (build_requests count === 0). Hidden once the app has any build. Further
 * targeting (paying >= 3 months, etc.) can be layered on later.
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { pushEvent } from '~/services/posthog'
import { getLocalConfig, useSupabase } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{ appId: string, active: boolean }>()
const emit = defineEmits<{ eligibility: [eligible: boolean], ready: [ready: boolean] }>()

const { t } = useI18n()
const config = getLocalConfig()
const supabase = useSupabase()
const organizationStore = useOrganizationStore()

const open = ref(false)
// hidden until we confirm the app has no builds (avoids a flash for ineligible apps)
const eligible = ref(false)
let shownTracked = false
// guards against out-of-order async results when appId changes quickly
let reqToken = 0

function track(event: string) {
  pushEvent(event, config.supaHost, {})
}

function openModal() {
  open.value = true
  track('builder_promo_banner_clicked')
}

// Only eligible when the current app has zero native builds.
async function checkEligibility() {
  const token = ++reqToken
  eligible.value = false
  emit('eligibility', false)
  emit('ready', false)
  const appId = props.appId
  if (!appId) {
    emit('ready', true)
    return
  }
  try {
    // currentOrganization is unreliable on app-based URLs (the app may belong
    // to an org other than the selected one), so resolve the app's owning org
    // explicitly — otherwise we'd count builds against the wrong org.
    await organizationStore.awaitInitialLoad()
    const orgId = organizationStore.getOrgByAppId(appId)?.gid
    if (!orgId)
      return
    const { count, error } = await supabase
      .from('build_requests')
      .select('id', { count: 'exact', head: true })
      .eq('owner_org', orgId)
      .eq('app_id', appId)
    // ignore a stale response superseded by a newer appId check
    if (token !== reqToken)
      return
    if (error || (count ?? 0) > 0)
      return
    eligible.value = true
  }
  catch (e) {
    console.error('[BuilderPromoBanner] eligibility check failed', e)
  }
  finally {
    if (token === reqToken) {
      emit('eligibility', eligible.value)
      emit('ready', true)
    }
  }
}

watch(
  () => props.appId,
  () => {
    // reset the per-session impression latch so each new app re-emits "shown"
    shownTracked = false
    checkEligibility()
  },
  { immediate: true },
)

watch(
  () => [props.active, eligible.value] as const,
  ([active, isEligible]) => {
    if (active && isEligible && !shownTracked) {
      shownTracked = true
      track('builder_promo_banner_shown')
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
    <div
      v-if="active && eligible"
      class="animate-fade-in mb-4 flex cursor-pointer flex-col gap-4 rounded-lg border border-blue-200/80 bg-blue-100/40 px-5 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-blue-700/70 dark:bg-[#121b3a] sm:flex-row sm:items-center sm:justify-between"
      role="button"
      tabindex="0"
      @click="openModal"
      @keydown.enter="openModal"
      @keydown.space.prevent="openModal"
    >
      <!-- Left: native-builds switch + message (mirrors DeploymentBanner layout) -->
      <div class="flex items-center gap-3">
        <div class="bpb-switch" aria-hidden="true">
          <div class="bpb-knob" />
        </div>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-800 dark:text-blue-50">
            {{ t('builder-promo-banner-title') }}
          </div>
          <div class="mt-0.5 text-xs text-slate-600 dark:text-blue-100/80">
            {{ t('builder-promo-banner-subtitle') }}
          </div>
        </div>
      </div>

      <!-- Right: CTA button (matches DeploymentBanner's deploy button) -->
      <button
        class="inline-flex flex-shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-blue-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-offset-2 focus:ring-offset-blue-100/40 dark:focus:ring-offset-[#121b3a]"
        @click.stop="openModal"
      >
        {{ t('builder-promo-banner-cta') }} →
      </button>
    </div>

    <BuilderPresentationModal :open="open" :app-id="appId" @close="open = false" />
  </div>
</template>

<style scoped>
/* Light mode: a clean "on" toggle — brand-blue track, white knob */
.bpb-switch {
  width: 46px;
  height: 24px;
  flex: none;
  border-radius: 999px;
  background: #119eff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.18);
  position: relative;
}
.bpb-knob {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
}

/* Dark mode: the glowy terminal-style toggle */
.dark .bpb-switch {
  background: #04121f;
  box-shadow:
    inset 0 0 0 2px #7dd3fc,
    0 0 14px rgba(17, 158, 255, 0.5);
}
.dark .bpb-knob {
  background: #7dd3fc;
  box-shadow: none;
}
</style>
