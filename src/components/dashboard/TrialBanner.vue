<script setup lang="ts">
/**
 * TrialBanner Component
 *
 * A distinctive banner shown on the dashboard to encourage trial users to subscribe.
 * Features a cute pure-CSS "googly eyes" effect where the pupils follow the cursor.
 * Native emojis are just text and their pupils can't be moved, so we build it cleanly with CSS.
 *
 * Visibility conditions:
 * - User is on trial (not paying, trial_left > 0)
 * - Account is 3+ hours old (based on org created_at)
 * - Organization has at least 1 app
 */

import type { ComponentPublicInstance } from 'vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { pushEvent } from '~/services/posthog'
import { getLocalConfig, useSupabase } from '~/services/supabase'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'
import { shouldShowBuilderPromo } from '~/utils/builderPromoVisibility'

const { t } = useI18n()
const organizationStore = useOrganizationStore()

const leftEye = ref<HTMLElement | null>(null)
const rightEye = ref<HTMLElement | null>(null)
const ctaRef = ref<ComponentPublicInstance | null>(null)
const excited = ref(false)

const leftPupil = ref({ x: 0, y: 0 })
const rightPupil = ref({ x: 0, y: 0 })

const currentOrg = computed(() => organizationStore.currentOrganization)
const config = getLocalConfig()
const supabase = useSupabase()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

function trackBannerEvent(eventName: string) {
  const org = currentOrg.value
  pushEvent(eventName, config.supaHost, {
    ...(org?.gid ? { org_id: org.gid } : {}),
    trial_days_left: org?.trial_left ?? 0,
    org_gid: org?.gid ?? '',
  })
}

function handleCtaClick() {
  trackBannerEvent('trial_banner_cta_clicked')
}

// Reactive time tick so the 3-hour age check re-evaluates without needing a page reload.
// Updates every 60s — plenty for a 3-hour threshold.
const nowTick = ref(Date.now())
let tickInterval: ReturnType<typeof setInterval> | null = null

const isTrial = computed(() => {
  const org = currentOrg.value
  if (!org)
    return false
  return !org.paying && (org.trial_left ?? 0) > 0
})

const isAccountOldEnough = computed(() => {
  const org = currentOrg.value
  if (!org?.created_at)
    return false
  const createdAt = new Date(org.created_at)
  const threeHoursAgo = new Date(nowTick.value - 3 * 60 * 60 * 1000)
  return createdAt < threeHoursAgo
})

const hasApps = computed(() => {
  const org = currentOrg.value
  return (org?.app_count ?? 0) > 0
})

const onboardingAppOrgId = computed(() => {
  const selectableOrganizations = organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org))
  const organization = selectableOrganizations[0]
  if (selectableOrganizations.length !== 1 || organization?.app_count !== 1)
    return undefined

  return organization.gid
})

const shouldShowTrialBanner = ref(true)
let onboardingAppRequest = 0

watch(onboardingAppOrgId, async (orgId) => {
  const request = ++onboardingAppRequest
  shouldShowTrialBanner.value = !orgId

  if (!orgId)
    return

  const { data, error } = await supabase
    .from('apps')
    .select('need_onboarding')
    .eq('owner_org', orgId)
    .limit(1)

  if (request !== onboardingAppRequest)
    return

  if (error || !data?.[0]) {
    shouldShowTrialBanner.value = true
    return
  }

  shouldShowTrialBanner.value = shouldShowBuilderPromo({
    organizationCount: 1,
    appCount: 1,
    appNeedsOnboarding: data[0].need_onboarding,
  })
}, { immediate: true })

const showBanner = computed(() => {
  return !hideExternalPurchaseFlows && isTrial.value && isAccountOldEnough.value && hasApps.value && shouldShowTrialBanner.value
})

// Whether we need the time tick running — true when the account-age check
// could still flip (trial user with apps but not yet 3 hours old).
const needsTick = computed(() => {
  return isTrial.value && hasApps.value && !isAccountOldEnough.value
})

const maxTravel = 4 // How far the pupil can move from center (px)

function calcOffset(eye: HTMLElement | null, ev: MouseEvent) {
  if (!eye)
    return { x: 0, y: 0 }

  const rect = eye.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  const dx = ev.clientX - cx
  const dy = ev.clientY - cy

  const dist = Math.hypot(dx, dy)
  if (dist === 0)
    return { x: 0, y: 0 }

  // Easing factor so they don't jump to the edge instantly
  const easedDist = Math.min(dist * 0.1, maxTravel)

  return {
    x: (dx / dist) * easedDist,
    y: (dy / dist) * easedDist,
  }
}

const exciteDistance = 80 // px from CTA edge to trigger excitement

function distToRect(x: number, y: number, rect: DOMRect): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right)
  const dy = Math.max(rect.top - y, 0, y - rect.bottom)
  return Math.hypot(dx, dy)
}

function handleMouseMove(e: MouseEvent) {
  if (!showBanner.value)
    return
  leftPupil.value = calcOffset(leftEye.value, e)
  rightPupil.value = calcOffset(rightEye.value, e)
  if (ctaRef.value) {
    const el = ctaRef.value.$el ?? ctaRef.value
    const ctaRect = (el as HTMLElement).getBoundingClientRect()
    excited.value = distToRect(e.clientX, e.clientY, ctaRect) < exciteDistance
  }
}

// Start the time tick whenever the account-age check could still flip (trial
// user with apps, but not yet 3 hours old). This lets showBanner turn true
// without requiring a page reload.
watch(needsTick, (needed) => {
  if (needed) {
    tickInterval = setInterval(() => {
      nowTick.value = Date.now()
    }, 60_000)
  }
  else if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}, { immediate: true })

// Only attach the mousemove listener (expensive) when the banner is visible.
watch(showBanner, (visible) => {
  if (visible) {
    trackBannerEvent('trial_banner_shown')
    window.addEventListener('mousemove', handleMouseMove)
  }
  else {
    window.removeEventListener('mousemove', handleMouseMove)
  }
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
  if (tickInterval)
    clearInterval(tickInterval)
})
</script>

<template>
  <div
    v-if="showBanner"
    class="mb-4 flex items-center gap-4 rounded-xl border border-blue-300/60 bg-gradient-to-r from-blue-50 via-blue-100/80 to-blue-50 px-5 py-3.5 shadow-sm animate-fade-in dark:border-blue-600/40 dark:from-[#0d1d3a] dark:via-[#112244] dark:to-[#0d1d3a]"
  >
    <!-- CSS Eyes that follow the cursor natively -->
    <div class="eyes-container" :class="{ 'eyes-excited': excited }" aria-hidden="true">
      <div ref="leftEye" class="eye">
        <div
          class="pupil"
          :style="{ transform: `translate(calc(-50% + ${leftPupil.x}px), calc(-50% + ${leftPupil.y}px))${excited ? ' scale(1.4)' : ''}` }"
        />
      </div>
      <div ref="rightEye" class="eye">
        <div
          class="pupil"
          :style="{ transform: `translate(calc(-50% + ${rightPupil.x}px), calc(-50% + ${rightPupil.y}px))${excited ? ' scale(1.4)' : ''}` }"
        />
      </div>
    </div>

    <!-- Message -->
    <p class="flex-1 text-sm font-medium text-slate-700 dark:text-blue-100">
      {{ t('trial-banner-message') }}
    </p>

    <!-- CTA button with sparkle particles -->
    <div class="cta-wrapper sparkles-active">
      <span v-for="i in 6" :key="i" class="sparkle" :class="`sparkle-${i}`" aria-hidden="true">✦</span>
      <router-link
        ref="ctaRef"
        to="/settings/organization/plans"
        class="d-btn cta-button cta-sparkle"
        @click="handleCtaClick"
      >
        {{ t('trial-banner-cta') }}
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.eyes-container {
  display: flex;
  gap: 3px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0 4px; /* Give them a bit of breathing room */
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); /* unused but harmless */
}

/* Pupil excitement is driven by inline transform scale — see template */

/* Base eyeball styling to look cute and native */
.eye {
  width: 20px;
  height: 25px;
  background-color: #ffffff;
  border: 2px solid #1e293b;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.1);
}

.dark .eye {
  border-color: #94a3b8;
  background-color: #f1f5f9;
}

/* Pupil that moves */
.pupil {
  width: 9px;
  height: 9px;
  background-color: #1e293b;
  border-radius: 50%;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  transition: transform 0.08s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  will-change: transform;
}

.dark .pupil {
  background-color: #0f172a;
}

/* Tiny cute highlight/glint on the pupil */
.pupil::after {
  content: '';
  position: absolute;
  top: 15%;
  right: 20%;
  width: 30%;
  height: 30%;
  background-color: white;
  border-radius: 50%;
  opacity: 0.9;
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

.cta-button {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.5rem;
  background-color: #119eff;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
  font-weight: 600;
  color: white;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  transition:
    all 0.25s ease,
    box-shadow 0.3s ease,
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  overflow: hidden;
}

.cta-button:hover {
  background-color: #0d8ae6;
  box-shadow:
    0 4px 6px -1px rgba(0, 0, 0, 0.1),
    0 2px 4px -2px rgba(0, 0, 0, 0.1);
}

.cta-button:focus {
  outline: none;
  box-shadow:
    0 0 0 2px #60a5fa,
    0 0 0 4px white;
}

.dark .cta-button:focus {
  box-shadow:
    0 0 0 2px #60a5fa,
    0 0 0 4px #112244;
}

/* Shimmer overlay — always active for sparkle effect */
.cta-button::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 30%,
    rgba(255, 255, 255, 0.35) 45%,
    rgba(255, 255, 255, 0.5) 50%,
    rgba(255, 255, 255, 0.35) 55%,
    transparent 70%
  );
  background-size: 250% 100%;
  background-position: 100% 0;
  border-radius: inherit;
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

@keyframes shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -50% 0;
  }
}

/* Always-on sparkle glow + shimmer */
.cta-sparkle {
  box-shadow:
    0 0 12px rgba(17, 158, 255, 0.35),
    0 4px 10px rgba(17, 158, 255, 0.2);
}

.cta-sparkle::before {
  opacity: 1;
  animation: shimmer 1.4s ease-in-out infinite;
}

/* Sparkle wrapper — positions sparkles relative to button */
.cta-wrapper {
  position: relative;
  flex-shrink: 0;
}

/* Base sparkle particle style */
.sparkle {
  position: absolute;
  font-size: 10px;
  color: #119eff;
  opacity: 0;
  pointer-events: none;
  z-index: 1;
  filter: drop-shadow(0 0 2px rgba(17, 158, 255, 0.6));
  transition: opacity 0.2s ease;
}

.dark .sparkle {
  color: #60b8ff;
  filter: drop-shadow(0 0 3px rgba(96, 184, 255, 0.7));
}

/* Show sparkles — always active */
.sparkles-active .sparkle {
  opacity: 1;
}

/* Sparkle animation — pop in, float, fade out */
@keyframes sparkle-float {
  0% {
    opacity: 0;
    transform: scale(0) rotate(0deg);
  }
  15% {
    opacity: 1;
    transform: scale(1.2) rotate(20deg);
  }
  50% {
    opacity: 0.8;
    transform: scale(0.9) rotate(45deg);
  }
  100% {
    opacity: 0;
    transform: scale(0.3) rotate(90deg) translateY(-6px);
  }
}

/* Position each sparkle around the button edges with staggered timing */
.sparkles-active .sparkle-1 {
  top: -8px;
  left: 10%;
  font-size: 11px;
  animation: sparkle-float 1.4s ease-in-out 0s infinite;
}

.sparkles-active .sparkle-2 {
  top: -6px;
  right: 15%;
  font-size: 9px;
  animation: sparkle-float 1.6s ease-in-out 0.3s infinite;
}

.sparkles-active .sparkle-3 {
  bottom: -8px;
  left: 20%;
  font-size: 8px;
  animation: sparkle-float 1.3s ease-in-out 0.5s infinite;
}

.sparkles-active .sparkle-4 {
  bottom: -6px;
  right: 10%;
  font-size: 10px;
  animation: sparkle-float 1.5s ease-in-out 0.2s infinite;
}

.sparkles-active .sparkle-5 {
  top: 50%;
  left: -10px;
  font-size: 9px;
  animation: sparkle-float 1.7s ease-in-out 0.4s infinite;
}

.sparkles-active .sparkle-6 {
  top: 40%;
  right: -10px;
  font-size: 11px;
  animation: sparkle-float 1.4s ease-in-out 0.6s infinite;
}
</style>
