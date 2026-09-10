<script setup lang="ts">
import gsap from 'gsap'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowLeft from '~icons/lucide/arrow-left'
import IconBatteryFull from '~icons/lucide/battery-full'
import IconCheck from '~icons/lucide/check'
import IconChevronLeft from '~icons/lucide/chevron-left'
import IconCode from '~icons/lucide/code-2'
import IconDatabase from '~icons/lucide/database'
import IconFlask from '~icons/lucide/flask-conical'
import IconHome from '~icons/lucide/house'
import IconLock from '~icons/lucide/lock-keyhole'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconGear from '~icons/lucide/settings'
import IconShield from '~icons/lucide/shield-check'
import IconSignal from '~icons/lucide/signal'
import IconSmartphone from '~icons/lucide/smartphone'
import IconSparkles from '~icons/lucide/sparkles'
import IconWifi from '~icons/lucide/wifi'

defineProps<{
  embedded?: boolean
}>()

const emit = defineEmits<{
  back: []
  continue: []
}>()

const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const reducedMotion = ref(false)
const setChannelCall = `await CapacitorUpdater.setChannel({ channel: 'beta', triggerAutoUpdate: true })`
const selfAssignPolicy = `allow_device_self_set: true`
let timeline: gsap.core.Timeline | null = null
let media: gsap.MatchMedia | null = null

gsap.registerPlugin(MotionPathPlugin)

function element(selector: string) {
  return root.value?.querySelector<HTMLElement>(selector) ?? null
}

function elements(selector: string) {
  return root.value ? Array.from(root.value.querySelectorAll<HTMLElement>(selector)) : []
}

const NETWORK_VIEWBOX_WIDTH = 1000
const NETWORK_VIEWBOX_HEIGHT = 680

function roundPath(value: number) {
  return Math.round(value * 10) / 10
}

function svgPoint(svg: SVGSVGElement, el: HTMLElement, yAnchor: 'top' | 'center' | 'bottom') {
  const svgRect = svg.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  if (svgRect.width < 1 || svgRect.height < 1)
    return null

  return {
    x: (rect.left + rect.width / 2 - svgRect.left) / svgRect.width * NETWORK_VIEWBOX_WIDTH,
    y: (rect.top + rect.height * (yAnchor === 'top' ? 0 : yAnchor === 'bottom' ? 1 : 0.5) - svgRect.top) / svgRect.height * NETWORK_VIEWBOX_HEIGHT,
  }
}

function curvePath(from: { x: number, y: number }, to: { x: number, y: number }) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) < 8) {
    return `M${roundPath(from.x)} ${roundPath(from.y)} C${roundPath(from.x)} ${roundPath(from.y + dy * 0.35)} ${roundPath(to.x)} ${roundPath(to.y - dy * 0.25)} ${roundPath(to.x)} ${roundPath(to.y)}`
  }

  return `M${roundPath(from.x)} ${roundPath(from.y)} C${roundPath(from.x + dx * 0.1)} ${roundPath(from.y + dy * 0.5)} ${roundPath(to.x)} ${roundPath(to.y - Math.max(64, dy * 0.5))} ${roundPath(to.x)} ${roundPath(to.y)}`
}

function syncRoutingPaths() {
  const svg = root.value?.querySelector<SVGSVGElement>('.csa-routing-network')
  const phone = element('.csa-routing-phone')
  const capgo = element('.csa-capgo-core')
  const production = element('.csa-production-policy .csa-routing-channel-card')
  const beta = element('.csa-beta-policy .csa-routing-channel-card')
  const staging = element('.csa-staging-policy .csa-routing-channel-card')
  if (!svg || !phone || !capgo || !production || !beta || !staging)
    return false

  const phoneCenter = svgPoint(svg, phone, 'center')
  const capgoCenter = svgPoint(svg, capgo, 'center')
  const productionTop = svgPoint(svg, production, 'top')
  const betaTop = svgPoint(svg, beta, 'top')
  const stagingTop = svgPoint(svg, staging, 'top')
  if (!phoneCenter || !capgoCenter || !productionTop || !betaTop || !stagingTop)
    return false

  productionTop.y += 8
  betaTop.y += 8
  stagingTop.y += 8

  svg.querySelector('.csa-path-request')?.setAttribute('d', curvePath(phoneCenter, capgoCenter))
  svg.querySelector('.csa-path-production')?.setAttribute('d', curvePath(capgoCenter, productionTop))
  svg.querySelector('.csa-path-beta')?.setAttribute('d', curvePath(capgoCenter, betaTop))
  svg.querySelector('.csa-path-staging')?.setAttribute('d', curvePath(capgoCenter, stagingTop))
  svg.querySelector('.csa-beta-path-glow')?.setAttribute('d', curvePath(capgoCenter, betaTop))
  return true
}

function renderedPathPoints(path: SVGPathElement) {
  const stage = element('.csa-stage')
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

function showFinalState() {
  syncRoutingPaths()
  const hidden = ['.csa-phone-scene', '.csa-code-scene', '.csa-aura']
  const visible = [
    '.csa-routing-scene',
    '.csa-routing-node',
    '.csa-beta-path-glow',
    '.csa-beta-policy-glow',
    '.csa-validation-check',
    '.csa-response-bubble',
    '.csa-local-channel',
    '.csa-routing-device-check',
    '.csa-takeaway',
  ]
  const routingHidden = ['.csa-request-bubble', '.csa-validation-checking', '.csa-request-packet', '.csa-policy-packet', '.csa-response-packet']

  gsap.set(hidden.map(element).filter(Boolean), { autoAlpha: 0 })
  gsap.set(routingHidden.flatMap(selector => elements(selector)), { autoAlpha: 0 })
  gsap.set(visible.flatMap(selector => elements(selector)), { autoAlpha: 1, clearProps: 'transform' })
  gsap.set(element('.csa-beta-policy'), { y: -4, scale: 1.035 })
}

function buildTimeline() {
  syncRoutingPaths()

  const aura = element('.csa-aura')
  const phoneScene = element('.csa-phone-scene')
  const phone = element('.csa-phone')
  const homeScreen = element('.csa-home-screen')
  const appIcon = element('.csa-app-icon')
  const appIconPulse = element('.csa-app-icon-pulse')
  const appHome = element('.csa-app-home')
  const settingsNav = element('.csa-settings-nav')
  const settingsNavPulse = element('.csa-settings-nav-pulse')
  const settingsScreen = element('.csa-settings-screen')
  const betaButton = element('.csa-beta-button')
  const betaButtonPulse = element('.csa-beta-button-pulse')
  const dialogLayer = element('.csa-dialog-layer')
  const dialogCard = element('.csa-dialog-card')
  const confirmButton = element('.csa-confirm-button')
  const confirmPulse = element('.csa-confirm-pulse')
  const versionOld = element('.csa-version-old')
  const versionNew = element('.csa-version-new')
  const productionChannel = element('.csa-production-channel')
  const betaChannel = element('.csa-beta-channel')
  const betaEnabled = element('.csa-beta-enabled')
  const successToast = element('.csa-success-toast')
  const codeScene = element('.csa-code-scene')
  const codePanel = element('.csa-code-panel')
  const codeLines = elements('.csa-code-line')
  const routingScene = element('.csa-routing-scene')
  const routingNodes = elements('.csa-routing-node')
  const channelCards = elements('.csa-routing-channel-card')
  const requestPath = root.value?.querySelector<SVGPathElement>('.csa-path-request') ?? null
  const betaPath = root.value?.querySelector<SVGPathElement>('.csa-path-beta') ?? null
  const requestPacket = element('.csa-request-packet')
  const policyPacket = element('.csa-policy-packet')
  const responsePacket = element('.csa-response-packet')
  const requestBubble = element('.csa-request-bubble')
  const responseBubble = element('.csa-response-bubble')
  const validationChecking = element('.csa-validation-checking')
  const betaPolicy = element('.csa-beta-policy')
  const betaPathGlow = element('.csa-beta-path-glow')
  const betaPolicyGlow = element('.csa-beta-policy-glow')
  const validationCheck = element('.csa-validation-check')
  const localChannel = element('.csa-local-channel')
  const deviceCheck = element('.csa-routing-device-check')
  const takeaway = element('.csa-takeaway')

  if (!requestPath || !betaPath || !requestPacket || !policyPacket || !responsePacket)
    return null

  const requestPoints = renderedPathPoints(requestPath)
  const betaPoints = renderedPathPoints(betaPath)

  if (!requestPoints.length || !betaPoints.length)
    return null

  const reverseRequestPoints = [...requestPoints].reverse()
  const reverseBetaPoints = [...betaPoints].reverse()

  gsap.set(aura, { autoAlpha: 1 })
  gsap.set(phoneScene, { autoAlpha: 1 })
  gsap.set(phone, { autoAlpha: 0, y: 18, scale: 1, force3D: false })
  gsap.set(homeScreen, { autoAlpha: 1 })
  gsap.set([appHome, settingsScreen, dialogLayer, versionNew, betaChannel, betaEnabled, successToast], { autoAlpha: 0 })
  gsap.set(appHome, { xPercent: 12, scale: 0.985 })
  gsap.set(settingsScreen, { xPercent: 12 })
  gsap.set(dialogCard, { y: 22, scale: 0.95 })
  gsap.set([appIconPulse, settingsNavPulse, betaButtonPulse, confirmPulse], { autoAlpha: 0, scale: 0.65 })
  gsap.set([codeScene, routingScene], { autoAlpha: 0 })
  gsap.set(codePanel, { y: 24, scale: 0.94 })
  gsap.set(codeLines, { autoAlpha: 0, x: 14 })
  gsap.set(routingNodes, { autoAlpha: 0, y: 16 })
  gsap.set([requestBubble, responseBubble, validationChecking, betaPathGlow, betaPolicyGlow, validationCheck, localChannel, takeaway], { autoAlpha: 0 })
  gsap.set([requestPacket, policyPacket, responsePacket], { autoAlpha: 0, xPercent: -50, yPercent: -50 })
  gsap.set(requestBubble, { y: 10 })
  gsap.set(responseBubble, { y: 10 })
  gsap.set(validationChecking, { y: 8 })
  gsap.set(element('.csa-lookup-dot'), { x: 0 })
  gsap.set(validationCheck, { y: 8 })
  gsap.set(localChannel, { y: 10, scale: 0.96 })
  gsap.set(deviceCheck, { autoAlpha: 0, scale: 0.4 })
  gsap.set(takeaway, { y: 14 })
  gsap.set(channelCards, { y: 0, scale: 1 })

  const animation = gsap.timeline({
    defaults: { ease: 'power2.out' },
  })

  animation
    .to(phone, { autoAlpha: 1, y: 0, duration: 0.55, force3D: false })
    .addLabel('open-app')
    .to(appIcon, { scale: 0.88, duration: 0.12, ease: 'power2.in' }, 'open-app+=0.48')
    .to(appIconPulse, { autoAlpha: 0.75, scale: 1.5, duration: 0.4 }, 'open-app+=0.48')
    .to(appIcon, { scale: 1, duration: 0.18 }, 'open-app+=0.6')
    .to(appIconPulse, { autoAlpha: 0, scale: 1.75, duration: 0.18 }, 'open-app+=0.76')
    .to(homeScreen, { autoAlpha: 0, scale: 1.04, duration: 0.34 }, 'open-app+=0.84')
    .to(appHome, { autoAlpha: 1, xPercent: 0, scale: 1, duration: 0.4 }, 'open-app+=0.88')
    .addLabel('open-settings')
    .to(settingsNav, { scale: 0.84, duration: 0.12, ease: 'power2.in' }, 'open-settings+=0.62')
    .to(settingsNavPulse, { autoAlpha: 0.7, scale: 1.65, duration: 0.35 }, 'open-settings+=0.62')
    .to(settingsNav, { scale: 1, duration: 0.17 }, 'open-settings+=0.74')
    .to(settingsNavPulse, { autoAlpha: 0, scale: 1.9, duration: 0.16 }, 'open-settings+=0.83')
    .to(appHome, { autoAlpha: 0, xPercent: -12, duration: 0.34 }, 'open-settings+=0.92')
    .to(settingsScreen, { autoAlpha: 1, xPercent: 0, duration: 0.38 }, 'open-settings+=0.96')
    .addLabel('open-beta-dialog')
    .to(betaButton, { scale: 0.97, duration: 0.12, ease: 'power2.in' }, 'open-beta-dialog+=0.62')
    .to(betaButtonPulse, { autoAlpha: 0.6, scale: 1.05, duration: 0.35 }, 'open-beta-dialog+=0.62')
    .to(betaButton, { scale: 1, duration: 0.17 }, 'open-beta-dialog+=0.74')
    .to(betaButtonPulse, { autoAlpha: 0, scale: 1.1, duration: 0.16 }, 'open-beta-dialog+=0.84')
    .to(dialogLayer, { autoAlpha: 1, duration: 0.22 }, 'open-beta-dialog+=0.9')
    .to(dialogCard, { y: 0, scale: 1, duration: 0.36, ease: 'back.out(1.3)' }, 'open-beta-dialog+=0.94')
    .addLabel('confirm-beta')
    .to(confirmButton, { scale: 0.97, duration: 0.12, ease: 'power2.in' }, 'confirm-beta+=0.72')
    .to(confirmPulse, { autoAlpha: 0.55, scale: 1.08, duration: 0.32 }, 'confirm-beta+=0.72')
    .to(confirmButton, { scale: 1, duration: 0.17 }, 'confirm-beta+=0.84')
    .to(confirmPulse, { autoAlpha: 0, scale: 1.14, duration: 0.16 }, 'confirm-beta+=0.93')
    .to(dialogCard, { y: 15, scale: 0.97, duration: 0.25, ease: 'power2.in' }, 'confirm-beta+=1.04')
    .to(dialogLayer, { autoAlpha: 0, duration: 0.22 }, 'confirm-beta+=1.08')
    .to([versionOld, productionChannel], { autoAlpha: 0, y: -7, duration: 0.2 }, 'confirm-beta+=1.24')
    .fromTo([versionNew, betaChannel], { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.06 }, 'confirm-beta+=1.34')
    .to(betaEnabled, { autoAlpha: 1, duration: 0.28 }, 'confirm-beta+=1.42')
    .fromTo(successToast, { autoAlpha: 0, y: -8, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.34, ease: 'back.out(1.4)' }, 'confirm-beta+=1.5')
    .addLabel('dismiss-phone')
    .to(phone, { autoAlpha: 0, y: -22, duration: 0.5, ease: 'power3.in', force3D: false }, 'dismiss-phone+=0.7')
    .to(phoneScene, { autoAlpha: 0, duration: 0.15 }, 'dismiss-phone+=1.12')
    .addLabel('show-code')
    .to(codeScene, { autoAlpha: 1, duration: 0.2 }, 'show-code+=0.1')
    .to(codePanel, { y: 0, scale: 1, duration: 0.48, ease: 'back.out(1.2)' }, 'show-code+=0.12')
    .to(codeLines, { autoAlpha: 1, x: 0, duration: 0.24, stagger: 0.07 }, 'show-code+=0.34')
    .addLabel('validate-channel')
    .to(codePanel, { autoAlpha: 0, y: -18, scale: 0.94, duration: 0.38, ease: 'power2.in' }, 'validate-channel+=1.3')
    .to(codeScene, { autoAlpha: 0, duration: 0.16 }, 'validate-channel+=1.6')
    .to(routingScene, { autoAlpha: 1, duration: 0.28 }, 'validate-channel+=1.62')
    .to(aura, { autoAlpha: 0, duration: 0.4 }, 'validate-channel+=1.62')
    .addLabel('routing-arrive', 'validate-channel+=1.72')
    .to(routingNodes, { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.08 }, 'routing-arrive')
    .addLabel('routing-request', '+=0.2')
    .to(requestBubble, { autoAlpha: 1, y: 0, duration: 0.35 }, 'routing-request')
    .set(requestPacket, { autoAlpha: 1 }, 'routing-request+=0.18')
    .to(requestPacket, {
      duration: 0.82,
      ease: 'power2.inOut',
      motionPath: { curviness: 0, fromCurrent: false, path: requestPoints },
    }, 'routing-request+=0.18')
    .to(requestPacket, { autoAlpha: 0, scale: 0.55, duration: 0.16 })
    .to(element('.csa-capgo-core'), { scale: 1.08, duration: 0.16, repeat: 1, yoyo: true }, '<')
    .addLabel('routing-lookup', '+=0.1')
    .to(requestBubble, { autoAlpha: 0, y: -8, duration: 0.22 }, 'routing-lookup')
    .to(validationChecking, { autoAlpha: 1, y: 0, duration: 0.32 }, 'routing-lookup')
    .to(element('.csa-lookup-dot'), { x: 18, duration: 0.7, repeat: 1, yoyo: true, ease: 'sine.inOut' }, 'routing-lookup+=0.15')
    .to(channelCards, { y: -4, duration: 0.2, stagger: 0.11, repeat: 1, yoyo: true }, 'routing-lookup+=0.14')
    .set(policyPacket, { autoAlpha: 1, scale: 1 }, 'routing-lookup+=0.38')
    .to(policyPacket, {
      duration: 0.64,
      ease: 'power2.inOut',
      motionPath: { curviness: 0, fromCurrent: false, path: betaPoints },
    }, 'routing-lookup+=0.38')
    .to(policyPacket, { autoAlpha: 0, scale: 0.55, duration: 0.14 })
    .addLabel('routing-allowed')
    .to(validationChecking, { autoAlpha: 0, y: -6, duration: 0.22 }, 'routing-allowed')
    .to([betaPathGlow, betaPolicyGlow], { autoAlpha: 1, scale: 1, duration: 0.35 }, 'routing-allowed')
    .to(betaPolicy, { y: -4, scale: 1.035, duration: 0.32 }, 'routing-allowed')
    .to(validationCheck, { autoAlpha: 1, y: 0, duration: 0.32 }, 'routing-allowed+=0.08')
    .set(responsePacket, { autoAlpha: 1, scale: 1 }, 'routing-allowed+=0.24')
    .to(responsePacket, {
      duration: 0.58,
      ease: 'power2.inOut',
      motionPath: { curviness: 0, fromCurrent: false, path: reverseBetaPoints },
    }, 'routing-allowed+=0.24')
    .to(responsePacket, { autoAlpha: 0, scale: 0.55, duration: 0.14 })
    .to(element('.csa-capgo-core'), { scale: 1.08, duration: 0.16, repeat: 1, yoyo: true }, '<')
    .set(responsePacket, { autoAlpha: 1, scale: 1 })
    .to(responsePacket, {
      duration: 0.78,
      ease: 'power2.inOut',
      motionPath: { curviness: 0, fromCurrent: false, path: reverseRequestPoints },
    })
    .to(responsePacket, { autoAlpha: 0, scale: 0.55, duration: 0.14 })
    .to(responseBubble, { autoAlpha: 1, y: 0, duration: 0.34 }, '<')
    .addLabel('store-on-device', '+=0.12')
    .to(deviceCheck, { autoAlpha: 1, scale: 1, duration: 0.34, ease: 'back.out(1.8)' }, 'store-on-device+=0.4')
    .to(localChannel, { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: 'back.out(1.35)' }, 'store-on-device+=0.45')
    .to(takeaway, { autoAlpha: 1, y: 0, duration: 0.4 }, 'store-on-device+=0.72')

  return animation
}

function createAnimation() {
  timeline?.kill()
  media?.revert()
  media = gsap.matchMedia()

  media.add('(prefers-reduced-motion: reduce)', () => {
    reducedMotion.value = true
    showFinalState()
  })

  media.add('(prefers-reduced-motion: no-preference)', () => {
    reducedMotion.value = false
    timeline = buildTimeline()
  })
}

function replay() {
  if (reducedMotion.value) {
    showFinalState()
    return
  }
  gsap.set(element('.csa-phone'), { autoAlpha: 0, y: 18, scale: 1, force3D: false })
  timeline?.kill()
  timeline = buildTimeline()
}

onMounted(async () => {
  await nextTick()
  createAnimation()
})

onBeforeUnmount(() => {
  timeline?.kill()
  media?.revert()
})
</script>

<template>
  <main ref="root" class="csa-shell overflow-hidden rounded-[1.6rem] border border-slate-200 bg-white shadow-xl shadow-slate-950/5 dark:border-white/10 dark:bg-slate-950" :class="{ 'csa-shell-embedded': embedded }">
    <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6 dark:border-white/10">
      <div class="min-w-0 max-w-3xl">
        <div class="mb-1 inline-flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-primary-600 dark:text-emerald-300">
          <IconSparkles class="h-3.5 w-3.5" />
          {{ t('channel-self-assign-kicker') }}
        </div>
        <h2 class="text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl dark:text-white">
          {{ t('channel-self-assign-title') }}
        </h2>
        <p class="mt-1 max-w-2xl text-xs leading-5 text-slate-600 sm:text-sm dark:text-slate-300">
          {{ t('channel-self-assign-description') }}
        </p>
      </div>
      <button type="button" class="d-btn d-btn-sm shrink-0 border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/15 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10" :aria-label="t('channel-self-assign-replay')" @click="replay">
        <IconRefresh class="h-4 w-4" />
        <span class="hidden sm:inline">{{ t('channel-self-assign-replay') }}</span>
      </button>
    </header>

    <section class="csa-stage relative isolate overflow-hidden" data-test="channel-self-assign-stage" role="img" :aria-label="t('channel-self-assign-stage-label')">
      <div class="csa-grid absolute inset-0 opacity-60" />
      <div class="csa-aura pointer-events-none absolute left-1/2 top-[52%] h-[18rem] w-[22rem] -translate-x-1/2 -translate-y-1/2 rounded-full" />

      <div class="csa-phone-scene absolute inset-0 z-20 flex items-center justify-center">
        <div class="csa-phone relative h-[29rem] w-[14.5rem] overflow-hidden rounded-[3rem] border border-slate-500/80 bg-[#111827] p-[0.38rem] shadow-[0_28px_74px_rgba(0,0,0,0.58)]">
          <div class="relative h-full overflow-hidden rounded-[2.35rem] bg-[#f7f9fc] text-slate-950">
            <div class="absolute left-1/2 top-1.5 z-50 h-5 w-[5.4rem] -translate-x-1/2 rounded-full bg-black" />
            <div class="absolute inset-x-0 top-0 z-40 flex h-9 items-center justify-between px-5 pt-0.5 text-[0.58rem] font-semibold">
              <span>9:41</span>
              <span class="flex items-center gap-1"><IconSignal class="h-2.5 w-2.5" /><IconWifi class="h-2.5 w-2.5" /><IconBatteryFull class="h-3 w-3" /></span>
            </div>

            <div class="csa-home-screen absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(124,233,210,0.9),transparent_31%),radial-gradient(circle_at_84%_35%,rgba(89,134,255,0.75),transparent_38%),linear-gradient(150deg,#0a2340_12%,#183c69_50%,#0a1224_100%)] px-5 pb-5 pt-12 text-white">
              <div class="flex items-end justify-between">
                <div>
                  <p class="text-[0.58rem] font-medium text-white/65">
                    {{ t('channel-self-assign-demo-date') }}
                  </p><p class="mt-0.5 text-lg font-semibold">
                    9:41
                  </p>
                </div>
                <div class="rounded-full bg-white/15 px-2 py-1 text-[0.52rem] backdrop-blur">
                  {{ t('channel-self-assign-demo-temperature') }}
                </div>
              </div>
              <div class="mt-7 grid grid-cols-3">
                <div class="csa-app-icon relative col-start-2 flex flex-col items-center gap-1.5">
                  <div class="csa-app-icon-pulse pointer-events-none absolute left-1/2 top-5 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-emerald-300 bg-emerald-300/25" />
                  <div class="relative flex h-13 w-13 items-center justify-center rounded-[1rem] bg-gradient-to-br from-emerald-300 via-cyan-400 to-blue-600 shadow-lg shadow-cyan-950/30">
                    <svg viewBox="0 0 32 32" class="h-7 w-7 text-white" fill="none" aria-hidden="true"><path d="M7 20.5 13.2 14l4.2 4.2L25 9.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /><path d="M21 9.5h4v4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </div>
                  <span class="text-[0.58rem] font-medium drop-shadow">{{ t('channel-self-assign-app-name') }}</span>
                </div>
              </div>
              <div class="absolute inset-x-4 bottom-4 flex h-14 items-center justify-around rounded-[1.3rem] border border-white/15 bg-white/15 px-2 backdrop-blur-xl">
                <IconHome class="h-6 w-6" /><IconSparkles class="h-6 w-6" /><IconGear class="h-6 w-6" />
              </div>
              <div class="absolute inset-x-0 bottom-1.5 flex justify-center">
                <div class="h-1 w-20 rounded-full bg-white/80" />
              </div>
            </div>

            <div class="csa-app-home absolute inset-0 bg-[#f5f7fb] px-4 pb-16 pt-11">
              <p class="text-[0.6rem] font-medium text-slate-500">
                {{ t('channel-self-assign-app-name') }}
              </p>
              <h3 class="mt-0.5 text-lg font-bold tracking-tight">
                {{ t('channel-self-assign-home-title') }}
              </h3>
              <div class="mt-4 rounded-2xl bg-gradient-to-br from-[#0e2a45] to-[#133c61] p-4 text-white shadow-lg shadow-slate-900/15">
                <p class="text-[0.56rem] font-medium uppercase tracking-widest text-cyan-100/70">
                  {{ t('channel-self-assign-portfolio-label') }}
                </p>
                <p class="mt-1 text-2xl font-semibold tracking-tight">
                  {{ t('channel-self-assign-home-balance') }}
                </p>
                <p class="mt-2 inline-flex rounded-full bg-emerald-400/15 px-2 py-1 text-[0.56rem] font-semibold text-emerald-300">
                  {{ t('channel-self-assign-portfolio-performance') }}
                </p>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <div v-for="item in ['AAPL', 'NVDA']" :key="item" class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <p class="text-[0.62rem] font-semibold">
                    {{ item }}
                  </p><div class="mt-2 h-6 rounded-md bg-gradient-to-r from-emerald-100 to-emerald-50" />
                </div>
              </div>
              <div class="absolute inset-x-3 bottom-3 h-13 rounded-[1.25rem] border border-slate-200 bg-white px-5 shadow-[0_10px_28px_rgba(15,23,42,0.14)]">
                <div class="flex h-full items-center justify-between">
                  <div class="flex flex-col items-center gap-0.5 text-emerald-600">
                    <IconHome class="h-5 w-5" /><span class="text-[0.48rem] font-semibold">{{ t('channel-self-assign-home-tab') }}</span>
                  </div>
                  <div class="flex flex-col items-center gap-0.5 text-slate-400">
                    <IconSparkles class="h-5 w-5" /><span class="text-[0.48rem] font-semibold">{{ t('channel-self-assign-discover-tab') }}</span>
                  </div>
                  <div class="csa-settings-nav relative flex flex-col items-center gap-0.5 text-slate-400">
                    <span class="csa-settings-nav-pulse pointer-events-none absolute left-1/2 top-2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-400 bg-emerald-300/20" /><IconGear class="relative h-5 w-5" /><span class="relative text-[0.48rem] font-semibold">{{ t('channel-self-assign-settings') }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="csa-settings-screen absolute inset-0 bg-[#f5f7fb] px-4 pb-7 pt-11">
              <div class="flex items-center gap-2">
                <div class="flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-600 shadow-sm">
                  <IconChevronLeft class="h-4 w-4" />
                </div><h3 class="text-lg font-bold tracking-tight">
                  {{ t('channel-self-assign-settings') }}
                </h3>
              </div>
              <div class="mt-4 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div class="flex items-center gap-3 border-b border-slate-100 pb-2.5">
                  <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                    <IconRefresh class="h-4 w-4" />
                  </div><div>
                    <p class="text-[0.7rem] font-semibold">
                      {{ t('channel-self-assign-updates') }}
                    </p><p class="text-[0.52rem] text-slate-500">
                      {{ t('channel-self-assign-ota-caption') }}
                    </p>
                  </div>
                </div>
                <div class="flex items-center justify-between py-2.5 text-[0.66rem]">
                  <span class="text-slate-500">{{ t('channel-self-assign-current-channel') }}</span><span class="relative h-4 min-w-16 text-right font-semibold"><span class="csa-production-channel absolute right-0">{{ t('channel-self-assign-production') }}</span><span class="csa-beta-channel absolute right-0 text-violet-600">{{ t('channel-self-assign-beta-channel') }}</span></span>
                </div>
                <div class="flex items-center justify-between border-t border-slate-100 pt-2.5 text-[0.66rem]">
                  <span class="text-slate-500">{{ t('channel-self-assign-current-version') }}</span><span class="relative h-4 min-w-24 text-right font-mono font-semibold"><span class="csa-version-old absolute right-0">1.0.0</span><span class="csa-version-new absolute right-0 text-violet-600">1.1.0-beta.1</span></span>
                </div>
              </div>
              <div class="csa-beta-button relative mt-3 overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-3.5 shadow-sm">
                <div class="csa-beta-button-pulse pointer-events-none absolute inset-0 rounded-2xl border-2 border-violet-400 bg-violet-200/40" />
                <div class="relative flex items-start gap-3">
                  <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
                    <IconFlask class="h-4 w-4" />
                  </div><div class="min-w-0">
                    <p class="text-[0.68rem] font-semibold text-violet-950">
                      {{ t('channel-self-assign-beta-action') }}
                    </p><p class="mt-0.5 text-[0.52rem] leading-3.5 text-violet-700/75">
                      {{ t('channel-self-assign-beta-caption') }}
                    </p>
                  </div>
                </div>
              </div>
              <div class="csa-beta-enabled mt-2.5 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-[0.6rem] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                <IconCheck class="h-3.5 w-3.5" />{{ t('channel-self-assign-beta-enabled') }}
              </div>
              <div class="absolute inset-x-0 bottom-1.5 flex justify-center">
                <div class="h-1 w-24 rounded-full bg-slate-950/80" />
              </div>
            </div>

            <div class="csa-dialog-layer absolute inset-0 z-30 flex items-end bg-slate-950/45 p-2.5 pb-4 backdrop-blur-[2px]">
              <div class="csa-dialog-card w-full rounded-[1.5rem] bg-white p-4 shadow-2xl">
                <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
                  <IconFlask class="h-4.5 w-4.5" />
                </div>
                <h4 class="mt-2.5 text-sm font-bold tracking-tight">
                  {{ t('channel-self-assign-dialog-title') }}
                </h4>
                <p class="mt-1 text-[0.61rem] leading-[0.95rem] text-slate-600">
                  {{ t('channel-self-assign-dialog-description') }}
                </p>
                <div class="csa-confirm-button relative mt-3 overflow-hidden rounded-xl bg-violet-600 px-3 py-2.5 text-center text-[0.62rem] font-semibold text-white shadow-md shadow-violet-600/20">
                  <span class="csa-confirm-pulse pointer-events-none absolute inset-0 rounded-xl border-2 border-violet-300 bg-white/20" /><span class="relative">{{ t('channel-self-assign-dialog-confirm') }}</span>
                </div>
              </div>
            </div>
            <div class="csa-success-toast absolute inset-x-4 top-10 z-40 flex items-center gap-2 rounded-xl bg-[#102337] px-3 py-2.5 text-[0.6rem] font-semibold text-white shadow-xl">
              <span class="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400 text-emerald-950"><IconCheck class="h-3.5 w-3.5" /></span>{{ t('channel-self-assign-success') }}
            </div>
          </div>
        </div>
      </div>

      <div class="csa-code-scene absolute inset-0 z-20 flex items-center justify-center px-4">
        <aside class="csa-code-panel w-full max-w-xl rounded-2xl border p-5 shadow-[0_26px_80px_rgba(0,0,0,0.22)] backdrop-blur" aria-live="polite">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-cyan-300">
              <IconCode class="h-4 w-4" />{{ t('channel-self-assign-code-label') }}
            </div><span class="rounded-full bg-white/5 px-2 py-1 text-[0.58rem] text-slate-400">{{ t('channel-self-assign-behind-scenes') }}</span>
          </div>
          <pre class="overflow-hidden rounded-xl bg-[#040b14] px-4 py-3 text-[0.72rem] leading-6 text-slate-300 ring-1 ring-white/10" :aria-label="setChannelCall"><code><span class="csa-code-line block"><span class="text-violet-300">await</span> CapacitorUpdater.setChannel({</span><span class="csa-code-line block">  <span class="text-cyan-300">channel</span>: <span class="text-emerald-300">'beta'</span>,</span><span class="csa-code-line block">  <span class="text-cyan-300">triggerAutoUpdate</span>: <span class="text-amber-300">true</span>,</span><span class="csa-code-line block">})</span></code></pre>
          <p class="mt-3 text-xs leading-5 text-slate-400">
            {{ t('channel-self-assign-code-description') }}
          </p>
        </aside>
      </div>

      <div class="csa-routing-scene absolute inset-0 z-20">
        <div class="csa-routing-canvas relative mx-auto h-full max-w-5xl">
          <span class="csa-orbit csa-orbit-one" aria-hidden="true" />
          <span class="csa-orbit csa-orbit-two" aria-hidden="true" />

          <svg class="csa-routing-network" viewBox="0 0 1000 680" preserveAspectRatio="none" aria-hidden="true">
            <path class="csa-routing-path csa-path-request" d="M500 150 C500 198 500 250 500 300" />
            <path class="csa-routing-path csa-path-production" d="M500 365 C320 398 200 446 193 480" />
            <path class="csa-routing-path csa-path-beta" d="M500 365 C500 410 500 448 500 480" />
            <path class="csa-routing-path csa-path-staging" d="M500 365 C680 398 800 446 807 480" />
            <path class="csa-beta-path-glow" d="M500 365 C500 410 500 448 500 480" />
          </svg>

          <div class="csa-request-packet csa-routing-packet">
            <span>?</span>
          </div>
          <div class="csa-policy-packet csa-routing-packet csa-routing-packet-policy">
            <IconShield />
          </div>
          <div class="csa-response-packet csa-routing-packet csa-routing-packet-success">
            <IconCheck />
          </div>

          <div class="csa-routing-node csa-routing-device">
            <div class="csa-routing-phone">
              <span class="csa-routing-phone-speaker" />
              <div class="csa-routing-phone-screen">
                <IconSmartphone />
                <strong>Acme</strong>
              </div>
              <span class="csa-routing-device-check"><IconCheck /></span>
            </div>
            <div class="csa-routing-device-meta">
              <strong>{{ t('channel-self-assign-device-node') }}</strong>
              <code>abc-123</code>
              <div class="csa-local-channel">
                <span><IconDatabase />{{ t('channel-self-assign-device-storage-title') }}</span>
                <strong>{{ t('channel-self-assign-device-storage-value') }}</strong>
              </div>
            </div>
          </div>

          <div class="csa-request-bubble csa-routing-bubble">
            <span>{{ t('channel-self-assign-device-node') }}</span>
            <strong>{{ t('channel-self-assign-validation-request') }}</strong>
            <code>channel: beta</code>
          </div>

          <div class="csa-response-bubble csa-routing-bubble csa-routing-bubble-success">
            <span>Capgo</span>
            <strong>{{ t('channel-self-assign-response-title') }}</strong>
            <code>{{ t('channel-self-assign-validation-allowed') }} · beta</code>
          </div>

          <div class="csa-routing-node csa-routing-capgo">
            <div class="csa-capgo-core">
              <span class="csa-capgo-pulse" aria-hidden="true" />
              <img src="/favicon.svg" alt="">
            </div>
            <strong>Capgo</strong>
          </div>

          <div class="csa-validation-checking csa-capgo-state">
            <span class="csa-lookup-track"><span class="csa-lookup-dot" /></span>
            {{ t('channel-self-assign-validation-checking') }}
          </div>

          <div class="csa-validation-check csa-capgo-state csa-capgo-state-success">
            <IconCheck />
            <span>
              <strong>{{ t('channel-self-assign-validation-check') }}</strong>
              <code>{{ selfAssignPolicy }}</code>
            </span>
          </div>

          <div class="csa-channels-label csa-routing-node">
            {{ t('channel-self-assign-channels-label') }}
          </div>

          <div class="csa-routing-node csa-routing-channel-node csa-production-policy">
            <div class="csa-routing-channel-card">
              <span class="csa-routing-channel-icon csa-channel-production"><span /></span>
              <span><strong>production</strong><code>self-assign: off</code></span>
              <IconLock class="csa-policy-lock" />
            </div>
          </div>

          <div class="csa-routing-node csa-routing-channel-node csa-beta-policy">
            <span class="csa-beta-policy-glow" aria-hidden="true" />
            <div class="csa-routing-channel-card csa-routing-channel-card-beta">
              <span class="csa-routing-channel-icon csa-channel-beta"><span /></span>
              <span><strong>beta</strong><code>self-assign: on</code></span>
              <span class="csa-policy-enabled"><IconCheck />{{ t('channel-self-assign-validation-allowed') }}</span>
            </div>
          </div>

          <div class="csa-routing-node csa-routing-channel-node csa-staging-policy">
            <div class="csa-routing-channel-card">
              <span class="csa-routing-channel-icon csa-channel-staging"><span /></span>
              <span><strong>staging</strong><code>self-assign: off</code></span>
              <IconLock class="csa-policy-lock" />
            </div>
          </div>

          <div class="csa-takeaway">
            <span class="csa-takeaway-icon"><IconSmartphone /></span>
            <span>
              <strong>{{ t('channel-self-assign-takeaway-title') }}</strong>
              {{ t('channel-self-assign-takeaway-description') }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <footer v-if="embedded" class="flex items-center justify-between border-t border-slate-200 bg-white px-5 py-3 sm:px-6 dark:border-white/10 dark:bg-slate-950">
      <button
        type="button"
        class="d-btn d-btn-ghost d-btn-square h-10 min-h-10 w-10 shrink-0"
        data-test="channel-self-assign-back"
        :aria-label="t('button-back')"
        :title="t('button-back')"
        @click="emit('back')"
      >
        <IconArrowLeft class="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" class="d-btn d-btn-primary h-12 min-h-12 shrink-0 px-5" data-test="channel-self-assign-continue" @click="emit('continue')">
        {{ t('continue') }}
      </button>
    </footer>
  </main>
</template>

<style scoped>
.csa-shell {
  container-type: inline-size;
}

.csa-stage {
  --csa-stage-text: var(--color-base-content);
  --csa-muted-text: color-mix(in srgb, var(--color-base-content) 62%, transparent);
  --csa-soft-text: color-mix(in srgb, var(--color-base-content) 76%, var(--color-secondary));
  --csa-panel-background: color-mix(in srgb, var(--color-base-100) 93%, transparent);
  --csa-panel-border: color-mix(in srgb, var(--color-base-content) 16%, transparent);
  --csa-panel-shadow: color-mix(in srgb, var(--color-base-content) 18%, transparent);
  --csa-success-background: color-mix(in srgb, var(--color-success) 12%, var(--color-base-100));
  --csa-success-border: color-mix(in srgb, var(--color-success) 38%, transparent);
  --csa-success-text: color-mix(in srgb, var(--color-success) 54%, var(--color-base-content));
  --csa-stage-background:
    radial-gradient(
      ellipse 78% 52% at 50% 58%,
      color-mix(in srgb, var(--color-secondary) 12%, transparent),
      transparent 70%
    ),
    linear-gradient(
      150deg,
      color-mix(in srgb, var(--color-base-100) 93%, #dbeafe) 0%,
      var(--color-base-200) 58%,
      color-mix(in srgb, var(--color-base-100) 92%, #dcfce7) 100%
    );
  height: clamp(27rem, 52vh, 30rem);
  min-height: 27rem;
  color: var(--csa-stage-text);
  background: var(--csa-stage-background);
}

@media (min-width: 851px) {
  .csa-shell-embedded .csa-stage {
    height: clamp(32rem, 55vh, 36rem);
    min-height: 32rem;
  }
}

.csa-grid {
  background-image:
    linear-gradient(color-mix(in srgb, var(--color-secondary) 9%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--color-secondary) 9%, transparent) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(circle at center, black 28%, transparent 80%);
}

.csa-aura {
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--color-secondary) 16%, transparent),
    color-mix(in srgb, var(--color-secondary) 7%, transparent) 42%,
    transparent 70%
  );
}

.csa-code-panel {
  color: var(--csa-stage-text);
  border-color: var(--csa-panel-border);
  background: var(--csa-panel-background);
  box-shadow: 0 1.6rem 5rem var(--csa-panel-shadow);
}

.csa-code-panel > div:first-child > div {
  color: var(--color-secondary);
}

.csa-code-panel > div:first-child > span {
  color: var(--csa-muted-text);
  background: color-mix(in srgb, var(--color-base-content) 5%, transparent);
}

.csa-code-panel > p {
  color: var(--csa-muted-text);
}

.csa-code-panel,
.csa-routing-node {
  will-change: transform, opacity;
}

.csa-routing-canvas {
  isolation: isolate;
}

.csa-orbit {
  position: absolute;
  left: 50%;
  z-index: -1;
  border: 1px solid color-mix(in srgb, var(--color-secondary) 14%, transparent);
  border-radius: 999px;
  pointer-events: none;
  transform: translateX(-50%);
}

.csa-orbit-one {
  top: -25rem;
  width: 52rem;
  height: 52rem;
}

.csa-orbit-two {
  top: -18rem;
  width: 39rem;
  height: 39rem;
}

.csa-routing-network {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.csa-routing-path,
.csa-beta-path-glow {
  fill: none;
  stroke-linecap: round;
}

.csa-routing-path {
  stroke: color-mix(in srgb, var(--color-secondary) 28%, transparent);
  stroke-width: 2.2;
  stroke-dasharray: 7 10;
}

.csa-path-request,
.csa-path-beta {
  stroke-width: 2.6;
}

.csa-beta-path-glow {
  stroke: rgb(49 214 161 / 24%);
  stroke-width: 10;
  opacity: 0.52;
}

.csa-routing-packet {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 8;
  display: grid;
  width: 1.4rem;
  height: 1.4rem;
  color: #061220;
  border: 3px solid #071322;
  border-radius: 999px;
  background: #7ecbff;
  box-shadow: 0 0 1.2rem rgb(83 174 255 / 75%);
  font-size: 0.7rem;
  font-weight: 900;
  place-items: center;
  will-change: transform, opacity;
}

.csa-routing-packet svg {
  width: 0.7rem;
  height: 0.7rem;
  stroke-width: 3;
}

.csa-routing-packet-policy {
  color: #102444;
  background: #8cbcff;
}

.csa-routing-packet-success {
  color: #06251b;
  background: #54e3b3;
  box-shadow: 0 0 1.2rem rgb(61 218 169 / 65%);
}

.csa-routing-node {
  position: absolute;
  z-index: 3;
}

.csa-routing-device {
  top: 0.6rem;
  left: 50%;
  display: flex;
  transform: translateX(-50%);
}

.csa-routing-phone {
  position: relative;
  width: 3.3rem;
  height: 5.55rem;
  padding: 0.32rem;
  border: 1px solid rgb(185 213 255 / 38%);
  border-radius: 0.95rem;
  background: linear-gradient(145deg, #1e2d45, #070b12 68%);
  box-shadow:
    0 1rem 2.8rem rgb(0 0 0 / 38%),
    inset 0 1px 0 rgb(255 255 255 / 12%);
}

.csa-routing-phone-speaker {
  position: absolute;
  top: 0.24rem;
  left: 50%;
  z-index: 2;
  width: 0.9rem;
  height: 0.13rem;
  border-radius: 999px;
  background: #05070b;
  transform: translateX(-50%);
}

.csa-routing-phone-screen {
  display: grid;
  gap: 0.25rem;
  height: 100%;
  color: #eef6ff;
  border-radius: 0.65rem;
  background:
    radial-gradient(circle at 50% 25%, rgb(71 169 255 / 34%), transparent 55%),
    linear-gradient(180deg, #10223b, #0a1525);
  font-size: 0.55rem;
  place-content: center;
  place-items: center;
}

.csa-routing-phone-screen svg {
  width: 1.35rem;
  height: 1.35rem;
  color: #70ecc4;
}

.csa-routing-device-check {
  position: absolute;
  right: -0.28rem;
  bottom: -0.28rem;
  display: grid;
  width: 1.15rem;
  height: 1.15rem;
  color: #06271c;
  border-radius: 999px;
  background: #4fe0ad;
  place-items: center;
}

.csa-routing-device-check svg {
  width: 0.72rem;
  height: 0.72rem;
  stroke-width: 3;
}

.csa-routing-device-meta {
  position: absolute;
  top: 50%;
  left: calc(100% + 0.75rem);
  display: grid;
  gap: 0.1rem;
  width: 11.5rem;
  color: var(--csa-stage-text);
  transform: translateY(-50%);
}

.csa-routing-device-meta > strong {
  font-size: 0.72rem;
}

.csa-routing-device-meta > code {
  color: var(--csa-muted-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.6rem;
}

.csa-local-channel {
  display: grid;
  gap: 0.16rem;
  margin-top: 0.25rem;
  padding: 0.38rem 0.48rem;
  color: var(--csa-stage-text);
  border: 1px solid var(--csa-success-border);
  border-radius: 0.55rem;
  background: var(--csa-success-background);
  box-shadow: 0 0.6rem 1.5rem var(--csa-panel-shadow);
}

.csa-local-channel span {
  display: flex;
  gap: 0.28rem;
  align-items: center;
  color: var(--csa-success-text);
  font-size: 0.43rem;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.csa-local-channel span svg {
  width: 0.62rem;
  height: 0.62rem;
}

.csa-local-channel strong {
  font-size: 0.56rem;
}

.csa-routing-bubble {
  position: absolute;
  top: 1.75rem;
  left: calc(50% + 7.4rem);
  z-index: 6;
  display: grid;
  gap: 0.18rem;
  width: 14.2rem;
  padding: 0.68rem 0.8rem;
  color: var(--csa-soft-text);
  border: 1px solid var(--csa-panel-border);
  border-radius: 0.82rem;
  background: var(--csa-panel-background);
  box-shadow:
    0 1rem 2.8rem var(--csa-panel-shadow),
    inset 0 1px 0 color-mix(in srgb, var(--color-base-content) 5%, transparent);
  backdrop-filter: blur(0.8rem);
  will-change: transform, opacity;
}

.csa-routing-bubble::before {
  position: absolute;
  top: 1.25rem;
  left: -0.35rem;
  width: 0.65rem;
  height: 0.65rem;
  border-bottom: 1px solid var(--csa-panel-border);
  border-left: 1px solid var(--csa-panel-border);
  background: var(--csa-panel-background);
  content: '';
  transform: rotate(45deg);
}

.csa-routing-bubble > span {
  color: var(--csa-muted-text);
  font-size: 0.5rem;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.csa-routing-bubble strong {
  color: var(--csa-stage-text);
  font-size: 0.72rem;
}

.csa-routing-bubble code {
  color: var(--csa-soft-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.57rem;
}

.csa-response-bubble {
  right: calc(50% + 5.4rem);
  left: auto;
  border-color: var(--csa-success-border);
  background: var(--csa-success-background);
}

.csa-response-bubble::before {
  right: -0.35rem;
  left: auto;
  border: 0;
  border-top: 1px solid var(--csa-success-border);
  border-right: 1px solid var(--csa-success-border);
  background: var(--csa-success-background);
}

.csa-response-bubble > span,
.csa-response-bubble code {
  color: var(--csa-success-text);
}

.csa-routing-capgo {
  top: 10.1rem;
  left: 50%;
  display: grid;
  gap: 0.35rem;
  justify-items: center;
  color: var(--csa-stage-text);
  font-size: 0.72rem;
  transform: translateX(-50%);
}

.csa-capgo-core {
  position: relative;
  display: grid;
  width: 4.2rem;
  height: 4.2rem;
  border: 1px solid rgb(140 192 255 / 34%);
  border-radius: 1.2rem;
  background: linear-gradient(145deg, rgb(37 99 235 / 90%), rgb(16 43 92 / 96%));
  box-shadow:
    0 1.15rem 3.2rem rgb(13 71 161 / 40%),
    inset 0 1px 0 rgb(255 255 255 / 28%);
  place-items: center;
  will-change: transform;
}

.csa-capgo-core img {
  position: relative;
  z-index: 1;
  width: 2.3rem;
  height: 2.3rem;
}

.csa-capgo-pulse {
  position: absolute;
  inset: -0.58rem;
  border: 1px solid rgb(72 160 255 / 20%);
  border-radius: 1.5rem;
  box-shadow: 0 0 0 0.58rem rgb(51 132 255 / 4%);
}

.csa-capgo-state {
  position: absolute;
  top: 10.8rem;
  left: calc(50% + 5.2rem);
  z-index: 6;
  display: inline-flex;
  gap: 0.48rem;
  align-items: center;
  max-width: 16rem;
  padding: 0.55rem 0.68rem;
  color: var(--csa-soft-text);
  border: 1px solid var(--csa-panel-border);
  border-radius: 0.7rem;
  background: var(--csa-panel-background);
  box-shadow: 0 0.85rem 2rem var(--csa-panel-shadow);
  font-size: 0.62rem;
  font-weight: 650;
  backdrop-filter: blur(0.6rem);
  will-change: transform, opacity;
}

.csa-lookup-track {
  display: block;
  flex: 0 0 auto;
  width: 1.8rem;
  height: 0.25rem;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-secondary) 18%, transparent);
}

.csa-lookup-dot {
  display: block;
  width: 0.65rem;
  height: 100%;
  border-radius: inherit;
  background: #58adff;
  box-shadow: 0 0 0.7rem rgb(72 160 255 / 75%);
  will-change: transform;
}

.csa-capgo-state-success {
  color: var(--csa-success-text);
  border-color: var(--csa-success-border);
  background: var(--csa-success-background);
}

.csa-capgo-state-success > svg {
  flex: 0 0 auto;
  width: 0.9rem;
  height: 0.9rem;
  color: #4ce0ad;
  stroke-width: 3;
}

.csa-capgo-state-success span {
  display: grid;
  gap: 0.08rem;
}

.csa-capgo-state-success strong {
  color: var(--csa-stage-text);
}

.csa-capgo-state-success code {
  color: var(--csa-success-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.5rem;
}

.csa-channels-label {
  top: 17.75rem;
  left: 50%;
  color: var(--csa-muted-text);
  font-size: 0.58rem;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  transform: translateX(-50%);
}

.csa-routing-channel-node {
  top: 19.25rem;
  width: 12rem;
}

.csa-production-policy {
  left: 4%;
}

.csa-beta-policy {
  left: 50%;
  transform: translateX(-50%);
}

.csa-staging-policy {
  right: 4%;
}

.csa-routing-channel-card {
  position: relative;
  display: grid;
  grid-template-columns: 2rem 1fr;
  gap: 0.58rem;
  align-items: center;
  min-height: 3.75rem;
  padding: 0.65rem;
  overflow: hidden;
  border: 1px solid var(--csa-panel-border);
  border-radius: 0.85rem;
  background: var(--csa-panel-background);
  box-shadow:
    0 1rem 2.5rem var(--csa-panel-shadow),
    inset 0 1px 0 color-mix(in srgb, var(--color-base-content) 4%, transparent);
  will-change: transform;
}

.csa-routing-channel-card > span:nth-child(2) {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
}

.csa-routing-channel-card strong {
  color: var(--csa-stage-text);
  font-size: 0.7rem;
}

.csa-routing-channel-card code {
  overflow: hidden;
  color: var(--csa-muted-text);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.5rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csa-routing-channel-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  color: #61b6ff;
  border: 1px solid var(--csa-panel-border);
  border-radius: 0.58rem;
  background: color-mix(in srgb, var(--color-base-content) 5%, transparent);
  place-items: center;
}

.csa-routing-channel-icon span {
  width: 0.65rem;
  height: 0.65rem;
  border: 2px solid currentcolor;
  border-radius: 0.2rem;
  transform: rotate(45deg);
}

.csa-channel-production {
  color: #43dfa9;
}

.csa-channel-beta {
  color: #a78bfa;
  background: rgb(139 92 246 / 10%);
}

.csa-channel-staging {
  color: #e6aa57;
}

.csa-policy-lock {
  position: absolute;
  top: 0.55rem;
  right: 0.55rem;
  width: 0.72rem;
  height: 0.72rem;
  color: var(--csa-muted-text);
}

.csa-routing-channel-card-beta {
  border-color: var(--csa-success-border);
  background: var(--csa-success-background);
}

.csa-beta-policy-glow {
  position: absolute;
  inset: -0.55rem;
  z-index: -1;
  border-radius: 1.2rem;
  background: rgb(36 211 157 / 20%);
  filter: blur(1.2rem);
  will-change: transform, opacity;
}

.csa-policy-enabled {
  position: absolute;
  top: 0.42rem;
  right: 0.42rem;
  display: inline-flex;
  gap: 0.18rem;
  align-items: center;
  padding: 0.16rem 0.3rem;
  color: var(--csa-success-text);
  border: 1px solid var(--csa-success-border);
  border-radius: 999px;
  background: rgb(36 171 129 / 11%);
  font-size: 0.4rem;
  font-weight: 850;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.csa-policy-enabled svg {
  width: 0.5rem;
  height: 0.5rem;
  stroke-width: 3;
}

.csa-takeaway {
  position: absolute;
  bottom: 0.55rem;
  left: 50%;
  z-index: 5;
  display: flex;
  gap: 0.65rem;
  align-items: center;
  width: min(31rem, calc(100% - 2rem));
  padding: 0.6rem 0.78rem;
  color: var(--csa-muted-text);
  border: 1px solid var(--csa-panel-border);
  border-radius: 0.82rem;
  background: var(--csa-panel-background);
  box-shadow: 0 1rem 2.5rem var(--csa-panel-shadow);
  font-size: 0.62rem;
  transform: translateX(-50%);
  backdrop-filter: blur(0.75rem);
  will-change: transform, opacity;
}

.csa-takeaway strong {
  display: block;
  color: var(--csa-stage-text);
  font-size: 0.72rem;
}

.csa-takeaway-icon {
  display: grid;
  flex: 0 0 auto;
  width: 1.85rem;
  height: 1.85rem;
  color: #6dbaff;
  border-radius: 0.58rem;
  background: rgb(62 143 235 / 12%);
  place-items: center;
}

.csa-takeaway-icon svg {
  width: 0.9rem;
  height: 0.9rem;
}

@container (max-width: 46rem) {
  .csa-phone {
    width: 14rem;
    height: 28rem;
  }

  .csa-routing-bubble {
    left: calc(50% + 5.8rem);
    width: 12.2rem;
  }

  .csa-response-bubble {
    right: calc(50% + 4.8rem);
    left: auto;
  }

  .csa-capgo-state {
    left: calc(50% + 4.7rem);
    max-width: 13rem;
  }

  .csa-routing-channel-node {
    width: 10rem;
  }

  .csa-production-policy {
    left: 2%;
  }

  .csa-staging-policy {
    right: 2%;
  }
}

@container (max-width: 34rem) {
  .csa-phone {
    width: 13.5rem;
    height: 27rem;
  }

  .csa-routing-device {
    left: 31%;
  }

  .csa-routing-device-meta {
    width: 9rem;
  }

  .csa-routing-bubble {
    right: 0.45rem;
    left: auto;
    width: 10.8rem;
    padding: 0.55rem 0.62rem;
  }

  .csa-response-bubble::before,
  .csa-request-bubble::before {
    display: none;
  }

  .csa-capgo-state {
    left: calc(50% + 3.8rem);
    max-width: 10.8rem;
    font-size: 0.54rem;
  }

  .csa-routing-channel-node {
    width: min(8.5rem, calc(33.333% - 0.75rem));
  }

  .csa-production-policy {
    left: 0.5%;
  }

  .csa-staging-policy {
    right: 0.5%;
  }

  .csa-routing-channel-card {
    grid-template-columns: 1.7rem 1fr;
    gap: 0.4rem;
    padding: 0.5rem;
  }

  .csa-routing-channel-icon {
    width: 1.7rem;
    height: 1.7rem;
  }

  .csa-policy-enabled,
  .csa-policy-lock {
    display: none;
  }

  .csa-takeaway {
    margin-inline: 0.35rem;
  }

  .csa-takeaway > span:last-child {
    font-size: 0;
  }

  .csa-takeaway strong {
    font-size: 0.67rem;
  }
}
</style>
