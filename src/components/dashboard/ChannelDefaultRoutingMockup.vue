<script setup lang="ts">
import { gsap } from 'gsap'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconCheck from '~icons/lucide/check'
import IconRefreshCw from '~icons/lucide/refresh-cw'
import IconServer from '~icons/lucide/server'
import IconSmartphone from '~icons/lucide/smartphone'

const props = withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})

const emit = defineEmits<{
  continue: []
}>()

gsap.registerPlugin(MotionPathPlugin)

const { t } = useI18n()
const rootEl = ref<HTMLElement | null>(null)
const prefersReducedMotion = ref(false)

let timeline: gsap.core.Timeline | null = null
let media: gsap.MatchMedia | null = null

function element<T extends Element>(root: HTMLElement, selector: string): T | null {
  return root.querySelector<T>(selector)
}

function elements(root: HTMLElement, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector))
}

function renderedPathPoints(root: HTMLElement, path: SVGPathElement) {
  const stage = element<HTMLElement>(root, '.cr-stage')
  const matrix = path.getScreenCTM()
  const svg = path.ownerSVGElement

  if (!stage || !matrix || !svg)
    return []

  const stageRect = stage.getBoundingClientRect()
  const stageOriginX = stageRect.left + stage.clientLeft
  const stageOriginY = stageRect.top + stage.clientTop
  const pathLength = path.getTotalLength()
  const svgPoint = svg.createSVGPoint()

  return Array.from({ length: 33 }, (_, index) => {
    const pathPoint = path.getPointAtLength(pathLength * index / 32)
    svgPoint.x = pathPoint.x
    svgPoint.y = pathPoint.y
    const screenPoint = svgPoint.matrixTransform(matrix)

    return {
      x: screenPoint.x - stageOriginX,
      y: screenPoint.y - stageOriginY,
    }
  })
}

function showFinalState(root: HTMLElement) {
  const hiddenAtRest = elements(root, '.cr-request-bubble, .cr-lookup-state, .cr-request-packet, .cr-fetch-packet, .cr-update-packet')
  const visibleAtEnd = elements(root, '.cr-node, .cr-fallback-state, .cr-response-bubble, .cr-production-glow, .cr-version-new, .cr-installed-check, .cr-takeaway')

  gsap.set(hiddenAtRest, { autoAlpha: 0 })
  gsap.set(visibleAtEnd, { autoAlpha: 1, x: 0, y: 0, scale: 1 })
  gsap.set(element(root, '.cr-version-old'), { autoAlpha: 0, y: -6 })
  gsap.set(element(root, '.cr-production-card'), { scale: 1.035, y: -4 })
  gsap.set(element(root, '.cr-production-name'), { color: 'var(--cr-production-name-active)' })
}

function buildTimeline(root: HTMLElement) {
  const requestPath = element<SVGPathElement>(root, '.cr-path-request')
  const productionPath = element<SVGPathElement>(root, '.cr-path-production')
  const requestPacket = element<HTMLElement>(root, '.cr-request-packet')
  const fetchPacket = element<HTMLElement>(root, '.cr-fetch-packet')
  const updatePacket = element<HTMLElement>(root, '.cr-update-packet')
  const nodes = elements(root, '.cr-node')
  const channelCards = elements(root, '.cr-channel-card')

  if (!requestPath || !productionPath || !requestPacket || !fetchPacket || !updatePacket)
    return null

  const requestPoints = renderedPathPoints(root, requestPath)
  const productionPoints = renderedPathPoints(root, productionPath)

  if (!requestPoints.length || !productionPoints.length)
    return null

  const reverseRequestPoints = [...requestPoints].reverse()
  const reverseProductionPoints = [...productionPoints].reverse()

  gsap.set(nodes, { autoAlpha: 0, y: 14 })
  gsap.set(elements(root, '.cr-request-bubble, .cr-lookup-state, .cr-fallback-state, .cr-response-bubble, .cr-production-glow, .cr-version-new, .cr-installed-check, .cr-takeaway'), { autoAlpha: 0 })
  gsap.set(elements(root, '.cr-request-packet, .cr-fetch-packet, .cr-update-packet'), { autoAlpha: 0, xPercent: -50, yPercent: -50 })
  gsap.set(element(root, '.cr-version-old'), { autoAlpha: 1, y: 0 })
  gsap.set(channelCards, { y: 0, scale: 1 })

  const animation = gsap.timeline({
    paused: true,
    defaults: { duration: 0.5, ease: 'power3.out' },
  })

  animation
    .addLabel('arrive')
    .to(nodes, { autoAlpha: 1, y: 0, stagger: 0.08 }, 'arrive')

    .addLabel('request', '+=0.35')
    .to(element(root, '.cr-request-bubble'), { autoAlpha: 1, y: 0, duration: 0.4 }, 'request')
    .set(requestPacket, { autoAlpha: 1 }, 'request+=0.18')
    .to(requestPacket, {
      duration: 0.95,
      ease: 'power2.inOut',
      motionPath: {
        curviness: 0,
        fromCurrent: false,
        path: requestPoints,
      },
    }, 'request+=0.18')
    .to(requestPacket, { autoAlpha: 0, scale: 0.55, duration: 0.18 })
    .to(element(root, '.cr-capgo-core'), { scale: 1.08, duration: 0.18, repeat: 1, yoyo: true, ease: 'power1.inOut' }, '<')

    .addLabel('lookup', '+=0.16')
    .to(element(root, '.cr-request-bubble'), { autoAlpha: 0, y: -8, duration: 0.25 }, 'lookup')
    .fromTo(element(root, '.cr-lookup-state'), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.35 }, 'lookup')
    .to(channelCards, { y: -5, duration: 0.22, stagger: 0.13, repeat: 1, yoyo: true, ease: 'power1.inOut' }, 'lookup+=0.2')
    .to(element(root, '.cr-lookup-dot'), { x: 18, duration: 0.7, repeat: 1, yoyo: true, ease: 'sine.inOut' }, 'lookup+=0.15')

    .addLabel('fallback', '+=0.15')
    .to(element(root, '.cr-lookup-state'), { autoAlpha: 0, y: -6, duration: 0.25 }, 'fallback')
    .fromTo(element(root, '.cr-fallback-state'), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 'fallback')
    .to(element(root, '.cr-production-glow'), { autoAlpha: 1, scale: 1, duration: 0.45 }, 'fallback+=0.12')
    .to(element(root, '.cr-production-card'), { y: -4, scale: 1.035, duration: 0.35 }, 'fallback+=0.12')
    .to(element(root, '.cr-default-badge'), { scale: 1.1, duration: 0.2, repeat: 1, yoyo: true, ease: 'power1.inOut' }, 'fallback+=0.22')

    .addLabel('fetch', '+=0.24')
    .set(fetchPacket, { autoAlpha: 1, scale: 1 }, 'fetch')
    .to(fetchPacket, {
      duration: 0.68,
      ease: 'power2.inOut',
      motionPath: {
        curviness: 0,
        fromCurrent: false,
        path: productionPoints,
      },
    }, 'fetch')
    .to(fetchPacket, { autoAlpha: 0, scale: 0.5, duration: 0.16 })
    .set(updatePacket, { autoAlpha: 1, scale: 1 })
    .to(updatePacket, {
      duration: 0.76,
      ease: 'power2.inOut',
      motionPath: {
        curviness: 0,
        fromCurrent: false,
        path: reverseProductionPoints,
      },
    })

    .to(updatePacket, { autoAlpha: 0, scale: 0.6, duration: 0.14 })
    .to(element(root, '.cr-capgo-core'), { scale: 1.06, duration: 0.14, repeat: 1, yoyo: true, ease: 'power1.inOut' }, '<')

    .addLabel('deliver')
    .set(updatePacket, { autoAlpha: 1, scale: 1 }, 'deliver')
    .to(updatePacket, {
      duration: 0.9,
      ease: 'power2.inOut',
      motionPath: {
        curviness: 0,
        fromCurrent: false,
        path: reverseRequestPoints,
      },
    }, 'deliver')
    .to(updatePacket, { autoAlpha: 0, scale: 0.55, duration: 0.16 })
    .fromTo(element(root, '.cr-response-bubble'), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.38 }, '<')
    .to(element(root, '.cr-version-old'), { autoAlpha: 0, y: -7, duration: 0.25 }, '<0.08')
    .fromTo(element(root, '.cr-version-new'), { autoAlpha: 0, y: 7 }, { autoAlpha: 1, y: 0, duration: 0.3 }, '<0.08')
    .fromTo(element(root, '.cr-installed-check'), { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.34, ease: 'back.out(1.8)' }, '<0.08')

    .addLabel('takeaway', '+=0.22')
    .fromTo(element(root, '.cr-takeaway'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.45 }, 'takeaway')

  return animation
}

function createAnimation() {
  const root = rootEl.value
  if (!root)
    return

  media = gsap.matchMedia()
  media.add('(prefers-reduced-motion: reduce)', () => {
    prefersReducedMotion.value = true
    showFinalState(root)
  })
  media.add('(prefers-reduced-motion: no-preference)', () => {
    prefersReducedMotion.value = false
    timeline = buildTimeline(root)
    timeline?.play()

    return () => {
      timeline?.kill()
      timeline = null
    }
  })
}

function replay() {
  timeline?.restart()
}

onMounted(async () => {
  await nextTick()
  createAnimation()
})

onBeforeUnmount(() => {
  timeline?.kill()
  media?.revert()
  timeline = null
  media = null
})
</script>

<template>
  <main ref="rootEl" class="cr-page" :class="{ 'cr-page-embedded': props.embedded }">
    <div class="cr-shell">
      <header class="cr-page-header">
        <div>
          <p class="cr-kicker">
            <span class="cr-kicker-dot" aria-hidden="true" />
            {{ t(props.embedded ? 'channel-onboarding-default-kicker' : 'channel-routing-mockup-kicker') }}
          </p>
          <h1>{{ t(props.embedded ? 'channel-onboarding-default-title' : 'channel-routing-mockup-title') }}</h1>
          <p class="cr-description">
            {{ t(props.embedded ? 'channel-onboarding-default-description' : 'channel-routing-mockup-description') }}
          </p>
        </div>

        <button
          v-if="!prefersReducedMotion"
          type="button"
          class="cr-replay"
          @click="replay"
        >
          <IconRefreshCw aria-hidden="true" />
          {{ t('channel-routing-mockup-replay') }}
        </button>
      </header>

      <section class="cr-stage" :aria-label="t('channel-routing-mockup-stage-label')" data-test="channel-default-routing-animation">
        <div class="cr-grid" aria-hidden="true" />
        <div class="cr-orbit cr-orbit-one" aria-hidden="true" />
        <div class="cr-orbit cr-orbit-two" aria-hidden="true" />

        <svg class="cr-network" viewBox="0 0 1000 680" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="cr-request-gradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stop-color="#8dd7ff" stop-opacity=".32" />
              <stop offset="1" stop-color="#3b82f6" stop-opacity=".9" />
            </linearGradient>
            <linearGradient id="cr-production-gradient" x1="1" x2="0" y1="0" y2="1">
              <stop offset="0" stop-color="#20d49a" stop-opacity=".95" />
              <stop offset="1" stop-color="#47a9ff" stop-opacity=".32" />
            </linearGradient>
            <filter id="cr-soft-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>

          <path class="cr-path cr-path-request" d="M500 146 C500 205 500 249 500 306" stroke="url(#cr-request-gradient)" />
          <path class="cr-path cr-path-channel cr-path-production" d="M500 384 C439 432 317 470 205 528" stroke="url(#cr-production-gradient)" />
          <path class="cr-path cr-path-channel" d="M500 384 C500 432 500 475 500 528" />
          <path class="cr-path cr-path-channel" d="M500 384 C561 432 683 470 795 528" />
          <path class="cr-path-glow" d="M500 384 C439 432 317 470 205 528" filter="url(#cr-soft-glow)" />
        </svg>

        <div class="cr-node cr-device-node">
          <div class="cr-phone" aria-hidden="true">
            <div class="cr-phone-speaker" />
            <div class="cr-phone-screen">
              <div class="cr-app-mark">
                <img src="/favicon.svg" alt="">
              </div>
              <span class="cr-app-name">Acme</span>
              <div class="cr-version-stack">
                <span class="cr-version-old">v1.1.0</span>
                <span class="cr-version-new">v1.2.0</span>
              </div>
            </div>
            <span class="cr-installed-check" data-test="phone-installed-check"><IconCheck /></span>
          </div>
          <div class="cr-device-meta">
            <span class="cr-node-label">{{ t('channel-routing-mockup-device') }}</span>
            <code>abc-123</code>
          </div>
        </div>

        <div class="cr-request-bubble cr-bubble">
          <span class="cr-bubble-label">{{ t('channel-routing-mockup-device-request') }}</span>
          <strong>{{ t('channel-routing-mockup-update-question') }}</strong>
          <code>{{ t('channel-routing-mockup-device-id') }}: abc-123</code>
        </div>

        <div class="cr-response-bubble cr-bubble cr-bubble-success">
          <span class="cr-bubble-label">{{ t('channel-routing-mockup-capgo-response') }}</span>
          <strong>{{ t('channel-routing-mockup-update-available') }}</strong>
          <code>v1.2.0 · production</code>
        </div>

        <div class="cr-request-packet cr-packet">
          <span>?</span>
        </div>
        <div class="cr-fetch-packet cr-packet cr-packet-fetch">
          <IconServer />
        </div>
        <div class="cr-update-packet cr-update-bundle">
          <span class="cr-bundle-dot" />
          v1.2.0
        </div>

        <div class="cr-node cr-capgo-node">
          <div class="cr-capgo-core">
            <span class="cr-capgo-pulse" aria-hidden="true" />
            <img src="/favicon.svg" alt="">
          </div>
          <span class="cr-node-label">Capgo</span>
        </div>

        <div class="cr-lookup-state cr-capgo-state">
          <span class="cr-lookup-track"><span class="cr-lookup-dot" /></span>
          {{ t('channel-routing-mockup-checking') }}
        </div>

        <div class="cr-fallback-state cr-capgo-state cr-capgo-state-success">
          <IconCheck aria-hidden="true" />
          <span>
            <strong>{{ t('channel-routing-mockup-not-assigned') }}</strong>
            {{ t('channel-routing-mockup-using-default') }}
          </span>
        </div>

        <div class="cr-channels-label cr-node">
          {{ t('channel-routing-mockup-channels-label') }}
        </div>

        <div class="cr-node cr-channel-node cr-production-node">
          <div class="cr-production-glow" aria-hidden="true" />
          <div class="cr-channel-card cr-production-card">
            <div class="cr-channel-icon cr-channel-icon-production">
              <span />
            </div>
            <div>
              <strong class="cr-production-name">production</strong>
              <span>v1.2.0</span>
            </div>
            <span class="cr-default-badge">{{ t('channel-routing-mockup-default') }}</span>
          </div>
        </div>

        <div class="cr-node cr-channel-node cr-dev-node">
          <div class="cr-channel-card">
            <div class="cr-channel-icon cr-channel-icon-dev">
              <span />
            </div>
            <div>
              <strong>dev</strong>
              <span>v1.4.0-dev.3</span>
            </div>
          </div>
        </div>

        <div class="cr-node cr-channel-node cr-staging-node">
          <div class="cr-channel-card">
            <div class="cr-channel-icon cr-channel-icon-staging">
              <span />
            </div>
            <div>
              <strong>staging</strong>
              <span>v1.3.0-rc.1</span>
            </div>
          </div>
        </div>

        <div class="cr-takeaway">
          <span class="cr-takeaway-icon"><IconSmartphone /></span>
          <span>
            <strong>{{ t('channel-routing-mockup-takeaway-title') }}</strong>
            {{ t('channel-routing-mockup-takeaway-description') }}
          </span>
        </div>
      </section>

      <footer v-if="props.embedded" class="cr-onboarding-footer">
        <button
          type="button"
          class="d-btn d-btn-primary min-h-12 gap-2 px-5"
          data-test="channel-default-routing-continue"
          @click="emit('continue')"
        >
          {{ t('continue') }}
        </button>
      </footer>
    </div>
  </main>
</template>

<style scoped>
.cr-page {
  --cr-blue: #4ca7ff;
  --cr-cyan: #70d6ff;
  --cr-green: #31d6a1;
  --cr-page-text: var(--color-base-content);
  --cr-muted-text: color-mix(in srgb, var(--color-base-content) 62%, transparent);
  --cr-soft-text: color-mix(in srgb, var(--color-base-content) 76%, var(--color-secondary));
  --cr-panel-background: color-mix(in srgb, var(--color-base-100) 92%, transparent);
  --cr-panel-border: color-mix(in srgb, var(--color-base-content) 16%, transparent);
  --cr-panel-shadow: color-mix(in srgb, var(--color-base-content) 18%, transparent);
  --cr-success-background: color-mix(in srgb, var(--color-success) 12%, var(--color-base-100));
  --cr-success-border: color-mix(in srgb, var(--color-success) 38%, transparent);
  --cr-success-text: color-mix(in srgb, var(--color-success) 54%, var(--color-base-content));
  --cr-stage-background:
    radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--color-secondary) 14%, transparent), transparent 20rem),
    linear-gradient(
      150deg,
      color-mix(in srgb, var(--color-base-100) 93%, #dbeafe) 0%,
      var(--color-base-200) 58%,
      color-mix(in srgb, var(--color-base-100) 92%, #dcfce7) 100%
    );
  --cr-production-name-active: color-mix(in srgb, var(--color-success) 62%, var(--color-base-content));
  min-height: 100vh;
  padding: clamp(1.25rem, 4vw, 3rem);
  color: var(--cr-page-text);
  background:
    radial-gradient(circle at 18% 10%, rgb(59 130 246 / 12%), transparent 28rem),
    radial-gradient(circle at 86% 92%, rgb(16 185 129 / 9%), transparent 28rem), var(--color-base-200);
  font-family: Avenir, 'Avenir Next', Montserrat, sans-serif;
}

.cr-shell {
  width: min(72rem, 100%);
  margin: 0 auto;
}

.cr-page-embedded {
  min-height: 0;
  padding: 0;
  background: transparent;
  font-family: inherit;
}

.cr-page-embedded .cr-shell {
  width: 100%;
}

.cr-page-embedded .cr-page-header h1 {
  font-size: clamp(1.65rem, 3vw, 2.35rem);
  line-height: 1.08;
}

.cr-page-embedded .cr-description {
  max-width: 48rem;
  font-size: 0.95rem;
}

.cr-page-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 2rem;
  margin-bottom: 1.25rem;
}

.cr-kicker {
  display: inline-flex;
  gap: 0.55rem;
  align-items: center;
  margin: 0 0 0.65rem;
  color: var(--color-secondary);
  font-size: 0.73rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.cr-kicker-dot {
  width: 0.46rem;
  height: 0.46rem;
  border-radius: 999px;
  background: #2ecb98;
  box-shadow: 0 0 0 0.28rem rgb(46 203 152 / 13%);
}

.cr-page-header h1 {
  max-width: 42rem;
  margin: 0;
  color: var(--cr-page-text);
  font-size: clamp(2rem, 4vw, 3.5rem);
  font-weight: 750;
  line-height: 0.98;
  letter-spacing: -0.052em;
  text-wrap: balance;
}

.cr-description {
  max-width: 42rem;
  margin: 0.9rem 0 0;
  color: var(--cr-muted-text);
  font-size: clamp(0.95rem, 1.8vw, 1.08rem);
  line-height: 1.55;
}

.cr-replay {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 0.55rem;
  align-items: center;
  min-height: 2.75rem;
  padding: 0 1rem;
  color: var(--cr-page-text);
  border: 1px solid var(--cr-panel-border);
  border-radius: 0.8rem;
  background: var(--cr-panel-background);
  box-shadow: 0 0.45rem 1.2rem var(--cr-panel-shadow);
  font-size: 0.82rem;
  font-weight: 750;
  cursor: pointer;
  transition:
    transform 160ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.cr-replay:hover {
  border-color: #98bffc;
  box-shadow: 0 0.55rem 1.5rem rgb(37 99 235 / 12%);
  transform: translateY(-1px);
}

.cr-replay:focus-visible {
  outline: 3px solid rgb(59 130 246 / 28%);
  outline-offset: 3px;
}

.cr-replay svg {
  width: 1rem;
  height: 1rem;
}

.cr-stage {
  position: relative;
  isolation: isolate;
  width: 100%;
  min-height: 42rem;
  overflow: hidden;
  border: 1px solid var(--cr-panel-border);
  border-radius: 1.65rem;
  background: var(--cr-stage-background);
  box-shadow:
    0 2.3rem 5rem var(--cr-panel-shadow),
    inset 0 1px 0 color-mix(in srgb, var(--color-base-content) 7%, transparent);
}

.cr-grid {
  position: absolute;
  inset: 0;
  z-index: -2;
  opacity: 0.34;
  background-image: radial-gradient(
    circle,
    color-mix(in srgb, var(--color-secondary) 24%, transparent) 1px,
    transparent 1px
  );
  background-size: 1.35rem 1.35rem;
  mask-image: radial-gradient(circle at 50% 48%, black, transparent 79%);
}

.cr-orbit {
  position: absolute;
  z-index: -1;
  border: 1px solid color-mix(in srgb, var(--color-secondary) 14%, transparent);
  border-radius: 999px;
  pointer-events: none;
}

.cr-orbit-one {
  top: -27rem;
  left: 50%;
  width: 58rem;
  height: 58rem;
  transform: translateX(-50%);
}

.cr-orbit-two {
  top: -19rem;
  left: 50%;
  width: 42rem;
  height: 42rem;
  transform: translateX(-50%);
}

.cr-network {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.cr-path {
  fill: none;
  stroke: color-mix(in srgb, var(--color-secondary) 28%, transparent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 7 10;
}

.cr-path-request,
.cr-path-production {
  stroke-width: 2.4;
}

.cr-path-glow {
  fill: none;
  stroke: rgb(49 214 161 / 24%);
  stroke-width: 9;
  opacity: 0.55;
}

.cr-node {
  position: absolute;
  z-index: 2;
  will-change: transform, opacity;
}

.cr-device-node {
  top: 1.45rem;
  left: 50%;
  display: block;
  transform: translateX(-50%);
}

.cr-phone {
  position: relative;
  width: 4.3rem;
  height: 7.25rem;
  padding: 0.42rem;
  border: 1px solid rgb(185 213 255 / 38%);
  border-radius: 1.15rem;
  background: linear-gradient(145deg, #1e2d45, #070b12 68%);
  box-shadow:
    0 1rem 2.8rem rgb(0 0 0 / 38%),
    inset 0 1px 0 rgb(255 255 255 / 12%);
}

.cr-phone-speaker {
  position: absolute;
  top: 0.32rem;
  left: 50%;
  z-index: 2;
  width: 1.15rem;
  height: 0.16rem;
  border-radius: 999px;
  background: #05070b;
  transform: translateX(-50%);
}

.cr-phone-screen {
  position: relative;
  display: grid;
  place-items: center;
  height: 100%;
  overflow: hidden;
  border-radius: 0.78rem;
  background:
    radial-gradient(circle at 50% 25%, rgb(71 169 255 / 34%), transparent 55%),
    linear-gradient(180deg, #10223b, #0a1525);
}

.cr-app-mark {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  margin-top: 0.7rem;
  place-items: center;
  border-radius: 0.55rem;
  background: rgb(255 255 255 / 94%);
  box-shadow: 0 0.45rem 1rem rgb(31 111 255 / 25%);
}

.cr-app-mark img {
  width: 1.18rem;
  height: 1.18rem;
}

.cr-app-name {
  margin-top: -0.45rem;
  color: #eef6ff;
  font-size: 0.67rem;
  font-weight: 750;
}

.cr-version-stack {
  position: relative;
  width: 100%;
  height: 1rem;
  margin-top: -0.72rem;
  color: #8fa7c7;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.54rem;
  text-align: center;
}

.cr-version-stack span {
  position: absolute;
  inset: 0;
}

.cr-version-new {
  color: #70ecc4;
}

.cr-phone > .cr-installed-check {
  position: absolute;
  right: -0.22rem;
  bottom: -0.22rem;
  display: grid;
  width: 1.1rem;
  height: 1.1rem;
  color: #06271c;
  border-radius: 999px;
  background: #4fe0ad;
  place-items: center;
}

.cr-installed-check svg {
  width: 0.7rem;
  height: 0.7rem;
  stroke-width: 3;
}

.cr-device-meta {
  position: absolute;
  top: 50%;
  left: calc(100% + 0.8rem);
  display: grid;
  gap: 0.18rem;
  align-content: center;
  transform: translateY(-50%);
  white-space: nowrap;
}

.cr-node-label {
  color: var(--cr-page-text);
  font-size: 0.78rem;
  font-weight: 780;
  letter-spacing: 0.01em;
}

.cr-device-meta code {
  color: var(--cr-muted-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.65rem;
}

.cr-capgo-node {
  top: 17.2rem;
  left: 50%;
  display: grid;
  gap: 0.5rem;
  justify-items: center;
  transform: translateX(-50%);
}

.cr-capgo-core {
  position: relative;
  display: grid;
  width: 5.15rem;
  height: 5.15rem;
  border: 1px solid rgb(140 192 255 / 34%);
  border-radius: 1.4rem;
  background: linear-gradient(145deg, rgb(37 99 235 / 90%), rgb(16 43 92 / 96%));
  box-shadow:
    0 1.15rem 3.2rem rgb(13 71 161 / 40%),
    inset 0 1px 0 rgb(255 255 255 / 28%);
  place-items: center;
  will-change: transform;
}

.cr-capgo-core img {
  position: relative;
  z-index: 1;
  width: 2.7rem;
  height: 2.7rem;
  filter: drop-shadow(0 0.45rem 0.7rem rgb(0 0 0 / 20%));
}

.cr-capgo-pulse {
  position: absolute;
  inset: -0.75rem;
  border: 1px solid rgb(72 160 255 / 20%);
  border-radius: 1.8rem;
  box-shadow: 0 0 0 0.7rem rgb(51 132 255 / 4%);
}

.cr-bubble {
  position: absolute;
  z-index: 5;
  display: grid;
  gap: 0.24rem;
  width: 15.8rem;
  padding: 0.8rem 0.95rem;
  color: var(--cr-soft-text);
  border: 1px solid var(--cr-panel-border);
  border-radius: 0.9rem;
  background: var(--cr-panel-background);
  box-shadow:
    0 1rem 2.8rem var(--cr-panel-shadow),
    inset 0 1px 0 color-mix(in srgb, var(--color-base-content) 5%, transparent);
  backdrop-filter: blur(0.8rem);
  will-change: transform, opacity;
}

.cr-request-bubble {
  top: 3.25rem;
  left: calc(50% + 7rem);
}

.cr-response-bubble {
  top: 3.25rem;
  right: calc(50% + 3.8rem);
}

.cr-bubble::before {
  position: absolute;
  top: 1.65rem;
  left: -0.38rem;
  width: 0.7rem;
  height: 0.7rem;
  border-bottom: 1px solid var(--cr-panel-border);
  border-left: 1px solid var(--cr-panel-border);
  background: var(--cr-panel-background);
  content: '';
  transform: rotate(45deg);
}

.cr-response-bubble::before {
  right: -0.38rem;
  left: auto;
  border: 0;
  border-top: 1px solid var(--cr-success-border);
  border-right: 1px solid var(--cr-success-border);
  background: var(--cr-success-background);
}

.cr-bubble-success {
  border-color: var(--cr-success-border);
  background: var(--cr-success-background);
}

.cr-bubble-label {
  color: var(--cr-muted-text);
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.cr-bubble-success .cr-bubble-label {
  color: var(--cr-success-text);
}

.cr-bubble strong {
  color: var(--cr-page-text);
  font-size: 0.81rem;
}

.cr-bubble code {
  color: var(--cr-soft-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.67rem;
}

.cr-bubble-success code {
  color: var(--cr-success-text);
}

.cr-capgo-state {
  position: absolute;
  top: 18.8rem;
  left: calc(50% + 5.7rem);
  z-index: 5;
  display: inline-flex;
  gap: 0.55rem;
  align-items: center;
  max-width: 17rem;
  padding: 0.65rem 0.78rem;
  color: var(--cr-soft-text);
  border: 1px solid var(--cr-panel-border);
  border-radius: 0.75rem;
  background: var(--cr-panel-background);
  box-shadow: 0 0.85rem 2rem var(--cr-panel-shadow);
  font-size: 0.7rem;
  font-weight: 650;
  backdrop-filter: blur(0.6rem);
  will-change: transform, opacity;
}

.cr-capgo-state-success {
  color: var(--cr-success-text);
  border-color: var(--cr-success-border);
  background: var(--cr-success-background);
}

.cr-capgo-state-success svg {
  flex: 0 0 auto;
  width: 1rem;
  height: 1rem;
  color: #4ce0ad;
  stroke-width: 3;
}

.cr-capgo-state-success span {
  display: grid;
}

.cr-capgo-state-success strong {
  color: var(--cr-page-text);
}

.cr-lookup-track {
  display: block;
  width: 2rem;
  height: 0.28rem;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-secondary) 18%, transparent);
}

.cr-lookup-dot {
  display: block;
  width: 0.72rem;
  height: 100%;
  border-radius: inherit;
  background: #58adff;
  box-shadow: 0 0 0.7rem rgb(72 160 255 / 75%);
  will-change: transform;
}

.cr-packet,
.cr-update-bundle {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 6;
  will-change: transform, opacity;
}

.cr-packet {
  display: grid;
  width: 1.45rem;
  height: 1.45rem;
  color: #061220;
  border: 3px solid #071322;
  border-radius: 999px;
  background: #7ecbff;
  box-shadow: 0 0 1.2rem rgb(83 174 255 / 75%);
  font-size: 0.72rem;
  font-weight: 900;
  place-items: center;
}

.cr-packet svg {
  width: 0.7rem;
  height: 0.7rem;
}

.cr-packet-fetch {
  color: #06251b;
  background: #54e3b3;
  box-shadow: 0 0 1.2rem rgb(61 218 169 / 65%);
}

.cr-update-bundle {
  display: inline-flex;
  gap: 0.38rem;
  align-items: center;
  padding: 0.34rem 0.55rem;
  color: #dffff4;
  border: 1px solid rgb(93 232 188 / 45%);
  border-radius: 0.55rem;
  background: #0b4438;
  box-shadow: 0 0 1.4rem rgb(37 208 157 / 35%);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.58rem;
  font-weight: 750;
  white-space: nowrap;
}

.cr-bundle-dot {
  width: 0.37rem;
  height: 0.37rem;
  border-radius: 999px;
  background: #5ff2c2;
  box-shadow: 0 0 0.5rem #5ff2c2;
}

.cr-channels-label {
  top: 28.2rem;
  left: 50%;
  color: var(--cr-muted-text);
  font-size: 0.62rem;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  transform: translateX(-50%);
}

.cr-channel-node {
  top: 31.3rem;
  width: 12.7rem;
}

.cr-production-node {
  left: 7.4%;
}

.cr-dev-node {
  left: 50%;
  transform: translateX(-50%);
}

.cr-staging-node {
  right: 7.4%;
}

.cr-channel-card {
  position: relative;
  display: grid;
  grid-template-columns: 2.2rem 1fr;
  gap: 0.65rem;
  align-items: center;
  min-height: 4.25rem;
  padding: 0.75rem;
  overflow: hidden;
  border: 1px solid var(--cr-panel-border);
  border-radius: 0.92rem;
  background: var(--cr-panel-background);
  box-shadow:
    0 1rem 2.5rem var(--cr-panel-shadow),
    inset 0 1px 0 color-mix(in srgb, var(--color-base-content) 4%, transparent);
  will-change: transform;
}

.cr-channel-card > div:nth-child(2) {
  display: grid;
  gap: 0.14rem;
  min-width: 0;
}

.cr-channel-card strong {
  color: var(--cr-page-text);
  font-size: 0.76rem;
}

.cr-channel-card > div:nth-child(2) > span {
  overflow: hidden;
  color: var(--cr-muted-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.56rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cr-channel-icon {
  display: grid;
  width: 2.2rem;
  height: 2.2rem;
  border: 1px solid var(--cr-panel-border);
  border-radius: 0.65rem;
  background: color-mix(in srgb, var(--color-base-content) 5%, transparent);
  place-items: center;
}

.cr-channel-icon span {
  display: block;
  width: 0.72rem;
  height: 0.72rem;
  border: 2px solid currentcolor;
  border-radius: 0.22rem;
  transform: rotate(45deg);
}

.cr-channel-icon-production {
  color: #43dfa9;
  background: rgb(41 193 143 / 9%);
}

.cr-channel-icon-dev {
  color: #61b6ff;
}

.cr-channel-icon-staging {
  color: #e6aa57;
}

.cr-production-card {
  border-color: var(--cr-success-border);
  background: var(--cr-success-background);
}

.cr-production-glow {
  position: absolute;
  inset: -0.55rem;
  z-index: -1;
  border-radius: 1.3rem;
  background: rgb(36 211 157 / 20%);
  filter: blur(1.25rem);
  will-change: transform, opacity;
}

.cr-default-badge {
  position: absolute;
  top: 0.48rem;
  right: 0.48rem;
  padding: 0.18rem 0.36rem;
  color: var(--cr-success-text);
  border: 1px solid var(--cr-success-border);
  border-radius: 999px;
  background: rgb(36 171 129 / 11%);
  font-size: 0.46rem;
  font-weight: 850;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  will-change: transform;
}

.cr-takeaway {
  position: absolute;
  bottom: 1.25rem;
  left: 50%;
  z-index: 4;
  display: flex;
  gap: 0.75rem;
  align-items: center;
  width: min(31rem, calc(100% - 2rem));
  padding: 0.75rem 0.95rem;
  color: var(--cr-muted-text);
  border: 1px solid var(--cr-panel-border);
  border-radius: 0.9rem;
  background: var(--cr-panel-background);
  box-shadow: 0 1rem 2.5rem var(--cr-panel-shadow);
  font-size: 0.7rem;
  transform: translateX(-50%);
  backdrop-filter: blur(0.75rem);
  will-change: transform, opacity;
}

.cr-takeaway strong {
  display: block;
  color: var(--cr-page-text);
  font-size: 0.78rem;
}

.cr-takeaway-icon {
  display: grid;
  flex: 0 0 auto;
  width: 2.1rem;
  height: 2.1rem;
  color: #6dbaff;
  border-radius: 0.65rem;
  background: rgb(62 143 235 / 12%);
  place-items: center;
}

.cr-takeaway-icon svg {
  width: 1rem;
  height: 1rem;
}

.cr-onboarding-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid rgb(148 163 184 / 22%);
}

@media (max-width: 850px) {
  .cr-page-header {
    align-items: start;
  }

  .cr-stage {
    min-height: 45rem;
  }

  .cr-request-bubble {
    top: 8.6rem;
    left: calc(50% + 2.2rem);
    width: 13.3rem;
  }

  .cr-response-bubble {
    top: 8.6rem;
    right: calc(50% + 2.2rem);
    width: 13.3rem;
  }

  .cr-capgo-node {
    top: 19.2rem;
  }

  .cr-capgo-state {
    top: 21rem;
    left: calc(50% + 5.4rem);
  }

  .cr-channels-label {
    top: 30.8rem;
  }

  .cr-channel-node {
    top: 33.3rem;
    width: 10.8rem;
  }

  .cr-production-node {
    left: 3%;
  }

  .cr-staging-node {
    right: 3%;
  }
}

@media (max-width: 650px) {
  .cr-page {
    padding: 1rem;
  }

  .cr-page-header {
    display: grid;
    gap: 1rem;
  }

  .cr-stage {
    min-height: 50rem;
    border-radius: 1.2rem;
  }

  .cr-device-node {
    left: 24%;
  }

  .cr-request-bubble,
  .cr-response-bubble {
    top: 2.2rem;
    right: 1rem;
    left: auto;
    width: 12.4rem;
  }

  .cr-capgo-node {
    top: 17.5rem;
  }

  .cr-capgo-state {
    top: 24rem;
    left: 50%;
    width: min(17rem, calc(100% - 2rem));
    transform: translateX(-50%);
  }

  .cr-channels-label {
    top: 31.5rem;
  }

  .cr-channel-node {
    top: auto;
    width: calc(33.333% - 0.75rem);
  }

  .cr-production-node,
  .cr-dev-node,
  .cr-staging-node {
    bottom: 7.8rem;
  }

  .cr-production-node {
    left: 0.65rem;
  }

  .cr-dev-node {
    left: 50%;
    transform: translateX(-50%);
  }

  .cr-staging-node {
    right: 0.65rem;
  }

  .cr-channel-card {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 0.58rem 0.35rem;
    text-align: center;
  }

  .cr-channel-icon {
    width: 1.8rem;
    height: 1.8rem;
  }

  .cr-channel-card > div:nth-child(2) > span {
    display: none;
  }

  .cr-default-badge {
    position: static;
    grid-column: 1;
  }
}

@media (min-width: 851px) {
  .cr-page-embedded .cr-page-header {
    margin-bottom: 0.75rem;
  }

  .cr-page-embedded .cr-stage {
    height: clamp(32rem, 55vh, 36rem);
    min-height: clamp(32rem, 55vh, 36rem);
  }

  .cr-page-embedded .cr-device-node {
    top: 2.5%;
  }

  .cr-page-embedded .cr-request-bubble,
  .cr-page-embedded .cr-response-bubble {
    top: 5%;
  }

  .cr-page-embedded .cr-capgo-node {
    top: 36%;
  }

  .cr-page-embedded .cr-capgo-state {
    top: 40%;
  }

  .cr-page-embedded .cr-channels-label {
    top: 63%;
  }

  .cr-page-embedded .cr-channel-node {
    top: 70%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cr-replay {
    display: none;
  }
}
</style>
