<script setup lang="ts">
import gsap from 'gsap'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconAppWindow from '~icons/lucide/app-window'
import IconArrowLeft from '~icons/lucide/arrow-left'
import IconBell from '~icons/lucide/bell'
import IconBox from '~icons/lucide/box'
import IconBarChart from '~icons/lucide/chart-no-axes-column-increasing'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconEye from '~icons/lucide/eye'
import IconFile from '~icons/lucide/file-text'
import IconKey from '~icons/lucide/key-round'
import IconLayoutDashboard from '~icons/lucide/layout-dashboard'
import IconMousePointer from '~icons/lucide/mouse-pointer-2'
import IconPanelLeft from '~icons/lucide/panel-left'
import IconPlus from '~icons/lucide/plus'
import IconSignal from '~icons/lucide/radio-tower'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconSearch from '~icons/lucide/search'
import IconSettings from '~icons/lucide/settings'
import IconSmartphone from '~icons/lucide/smartphone'
import IconSparkles from '~icons/lucide/sparkles'
import IconWrench from '~icons/lucide/wrench'

withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})

const emit = defineEmits<{
  back: []
  continue: []
}>()

const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const reducedMotion = ref(false)
let timeline: gsap.core.Timeline | null = null
let media: gsap.MatchMedia | null = null
let resizeObserver: ResizeObserver | null = null
let resizeAnimationFrame: number | null = null

function element(selector: string) {
  return root.value?.querySelector<HTMLElement>(selector) ?? null
}

function elements(selector: string) {
  return root.value ? Array.from(root.value.querySelectorAll<HTMLElement>(selector)) : []
}

function targetPoint(stage: HTMLElement, target: HTMLElement) {
  const stageRect = stage.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  return {
    x: targetRect.left - stageRect.left + targetRect.width / 2,
    y: targetRect.top - stageRect.top + targetRect.height * 0.4,
  }
}

function moveAndClickTarget(
  animation: gsap.core.Timeline,
  cursor: HTMLElement,
  clickPulse: HTMLElement,
  stage: HTMLElement,
  target: HTMLElement,
  position: string,
  duration = 0.58,
  offset = 0,
) {
  const point = targetPoint(stage, target)
  const at = (delta: number) => `${position}+=${(duration + offset + delta).toFixed(2)}`
  const clickAt = at(0)
  const releaseAt = at(0.1)
  const fadePulseAt = at(0.28)
  const hidePulseAt = at(0.5)
  animation
    .to(cursor, {
      autoAlpha: 1,
      x: point.x,
      y: point.y,
      duration,
      ease: 'power3.inOut',
    }, position)
    .set(clickPulse, { x: point.x, y: point.y, xPercent: -50, yPercent: -50, autoAlpha: 0, scale: 0.55 }, clickAt)
    .to(cursor, { scale: 0.78, duration: 0.1, ease: 'power2.in' }, clickAt)
    .to(target, { scale: 0.985, duration: 0.1, ease: 'power2.in' }, clickAt)
    .to(clickPulse, { autoAlpha: 0.78, scale: 1.45, duration: 0.28 }, clickAt)
    .to(cursor, { scale: 1, duration: 0.14 }, releaseAt)
    .to(target, { scale: 1, duration: 0.16 }, releaseAt)
    .to(clickPulse, { autoAlpha: 0, scale: 1.8, duration: 0.2 }, fadePulseAt)
    .set(clickPulse, { autoAlpha: 0 }, hidePulseAt)
}

function showFinalState() {
  const frame = element('.csa-console-frame')
  const cursor = element('.csa-console-cursor')
  const clickPulse = element('.csa-console-click-pulse')
  const scenes = elements('.csa-console-scene')
  const deviceScene = element('.csa-console-device-scene')
  const dashboardNav = element('.csa-dashboard-nav')
  const appsNav = element('.csa-apps-nav')
  const channelMenu = element('.csa-console-channel-menu')
  const noneValue = element('.csa-console-channel-none')
  const devValue = element('.csa-console-channel-dev-value')
  const successToast = element('.csa-console-success-toast')

  gsap.set(frame, { autoAlpha: 1, y: 0 })
  gsap.set(scenes, { autoAlpha: 0, x: 0 })
  gsap.set(deviceScene, { autoAlpha: 1, x: 0 })
  gsap.set([cursor, clickPulse, channelMenu, noneValue], { autoAlpha: 0 })
  gsap.set([devValue, successToast], { autoAlpha: 1, x: 0, y: 0, scale: 1 })
  gsap.set(dashboardNav, { backgroundColor: 'transparent', color: '#94a3b8' })
  gsap.set(appsNav, { backgroundColor: '#334155', color: '#60a5fa' })
}

function buildTimeline() {
  const stage = element('.csa-console-stage')
  const frame = element('.csa-console-frame')
  const cursor = element('.csa-console-cursor')
  const clickPulse = element('.csa-console-click-pulse')
  const clickTargets = elements('.csa-console-click-target')
  const dashboardScene = element('.csa-console-dashboard-scene')
  const appsScene = element('.csa-console-apps-scene')
  const appScene = element('.csa-console-app-scene')
  const devicesScene = element('.csa-console-devices-scene')
  const deviceScene = element('.csa-console-device-scene')
  const dashboardNav = element('.csa-dashboard-nav')
  const appsNav = element('.csa-apps-nav')
  const appRow = element('.csa-app-row')
  const devicesTab = element('.csa-devices-tab-dashboard')
  const deviceRow = element('.csa-device-row')
  const channelTrigger = element('.csa-channel-trigger')
  const channelMenu = element('.csa-console-channel-menu')
  const devOption = element('.csa-channel-dev')
  const noneValue = element('.csa-console-channel-none')
  const devValue = element('.csa-console-channel-dev-value')
  const successToast = element('.csa-console-success-toast')

  if (!stage || !frame || !cursor || !clickPulse || !dashboardScene || !appsScene || !appScene || !devicesScene || !deviceScene || !dashboardNav || !appsNav || !appRow || !devicesTab || !deviceRow || !channelTrigger || !channelMenu || !devOption || !noneValue || !devValue || !successToast)
    return null

  gsap.set(frame, { autoAlpha: 0, y: 12 })
  gsap.set([appsScene, appScene, devicesScene, deviceScene], { autoAlpha: 0, x: 16 })
  gsap.set(dashboardScene, { autoAlpha: 1, x: 0 })
  gsap.set(cursor, { autoAlpha: 0, x: stage.clientWidth * 0.72, y: stage.clientHeight * 0.68, scale: 1, transformOrigin: '17% 20%' })
  gsap.set(clickPulse, { autoAlpha: 0, xPercent: -50, yPercent: -50, scale: 0.55 })
  gsap.set(clickTargets, { scale: 1, transformOrigin: 'center' })
  gsap.set(channelMenu, { autoAlpha: 0, y: -7, scale: 0.96, transformOrigin: 'top right' })
  gsap.set([devValue, successToast], { autoAlpha: 0 })
  gsap.set(devValue, { y: 5 })
  gsap.set(successToast, { x: 14, y: -8, scale: 0.96 })
  gsap.set(dashboardNav, { backgroundColor: '#334155', color: '#60a5fa' })
  gsap.set(appsNav, { backgroundColor: 'transparent', color: '#94a3b8' })

  const animation = gsap.timeline({
    paused: true,
    defaults: { ease: 'power3.out' },
  })

  animation
    .addLabel('dashboard-arrive')
    .to(frame, { autoAlpha: 1, y: 0, duration: 0.48 }, 'dashboard-arrive')

    .addLabel('open-apps', '+=0.65')

  moveAndClickTarget(animation, cursor, clickPulse, stage, appsNav, 'open-apps')

  animation
    .to(dashboardNav, { backgroundColor: 'transparent', color: '#94a3b8', duration: 0.22 }, 'open-apps+=1.02')
    .to(appsNav, { backgroundColor: '#334155', color: '#60a5fa', duration: 0.22 }, 'open-apps+=1.02')
    .to(dashboardScene, { autoAlpha: 0, x: -14, duration: 0.28 }, 'open-apps+=1.08')
    .to(appsScene, { autoAlpha: 1, x: 0, duration: 0.34 }, 'open-apps+=1.14')

    .addLabel('open-acme', '+=0.55')

  moveAndClickTarget(animation, cursor, clickPulse, stage, appRow, 'open-acme')

  animation
    .to(appsScene, { autoAlpha: 0, x: -14, duration: 0.28 }, 'open-acme+=1.08')
    .to(appScene, { autoAlpha: 1, x: 0, duration: 0.34 }, 'open-acme+=1.14')

    .addLabel('open-devices', '+=0.58')

  moveAndClickTarget(animation, cursor, clickPulse, stage, devicesTab, 'open-devices')

  animation
    .to(appScene, { autoAlpha: 0, x: -14, duration: 0.28 }, 'open-devices+=1.08')
    .to(devicesScene, { autoAlpha: 1, x: 0, duration: 0.34 }, 'open-devices+=1.14')

    .addLabel('open-device', '+=0.58')

  moveAndClickTarget(animation, cursor, clickPulse, stage, deviceRow, 'open-device')

  animation
    .to(devicesScene, { autoAlpha: 0, x: -14, duration: 0.28 }, 'open-device+=1.08')
    .to(deviceScene, { autoAlpha: 1, x: 0, duration: 0.34 }, 'open-device+=1.14')

    .addLabel('open-channel-override', '+=0.62')

  moveAndClickTarget(animation, cursor, clickPulse, stage, channelTrigger, 'open-channel-override')

  animation
    .to(channelMenu, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: 'back.out(1.25)' }, 'open-channel-override+=0.75')

    .addLabel('assign-dev', '+=0.45')

  moveAndClickTarget(animation, cursor, clickPulse, stage, devOption, 'assign-dev', 0.48)

  animation
    .to(channelMenu, { autoAlpha: 0, y: -5, scale: 0.98, duration: 0.2 }, 'assign-dev+=0.98')
    .to(noneValue, { autoAlpha: 0, y: -5, duration: 0.18 }, 'assign-dev+=1')
    .to(devValue, { autoAlpha: 1, y: 0, duration: 0.24 }, 'assign-dev+=1.08')

    .addLabel('assignment-complete', '+=0.18')
    .to(successToast, { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: 0.38, ease: 'back.out(1.35)' }, 'assignment-complete')
    .to(cursor, { autoAlpha: 0, y: '+=8', duration: 0.28 }, 'assignment-complete+=0.25')

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
    timeline?.play(0)
  })
}

function refreshAnimationAfterResize() {
  if (resizeAnimationFrame !== null)
    window.cancelAnimationFrame(resizeAnimationFrame)
  resizeAnimationFrame = window.requestAnimationFrame(() => {
    resizeAnimationFrame = null
    createAnimation()
  })
}

function replay() {
  if (reducedMotion.value) {
    showFinalState()
    return
  }
  createAnimation()
}

onMounted(async () => {
  await nextTick()
  createAnimation()
  if (root.value) {
    resizeObserver = new ResizeObserver(refreshAnimationAfterResize)
    resizeObserver.observe(root.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (resizeAnimationFrame !== null)
    window.cancelAnimationFrame(resizeAnimationFrame)
  timeline?.kill()
  media?.revert()
})
</script>

<template>
  <main ref="root" class="csa-console-shell overflow-hidden rounded-[1.6rem] border border-slate-200 bg-white shadow-xl shadow-slate-950/5 dark:border-white/10 dark:bg-slate-950" :class="{ 'csa-console-shell-embedded': embedded }">
    <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6 dark:border-white/10">
      <div class="min-w-0 max-w-3xl">
        <div class="mb-1 inline-flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-primary-600 dark:text-emerald-300">
          <IconSparkles class="h-3.5 w-3.5" />
          {{ t('channel-console-assign-kicker') }}
        </div>
        <h2 class="text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl dark:text-white">
          {{ t('channel-console-assign-title') }}
        </h2>
        <p class="mt-1 max-w-2xl text-xs leading-5 text-slate-600 sm:text-sm dark:text-slate-300">
          {{ t('channel-console-assign-description') }}
        </p>
      </div>
      <button type="button" class="d-btn d-btn-sm shrink-0 border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-white/15 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10" :aria-label="t('channel-console-assign-replay')" @click="replay">
        <IconRefresh class="h-4 w-4" />
        <span class="hidden sm:inline">{{ t('channel-console-assign-replay') }}</span>
      </button>
    </header>

    <section class="csa-console-stage relative isolate overflow-hidden" data-test="channel-console-assign-stage" role="img" :aria-label="t('channel-console-assign-stage-label')">
      <div class="csa-console-backdrop absolute inset-0" />
      <div class="csa-console-frame absolute inset-3 grid overflow-hidden rounded-xl border border-slate-300 bg-slate-50 shadow-2xl shadow-slate-950/25 sm:inset-4">
        <aside class="csa-console-sidebar relative z-10 flex min-w-0 flex-col bg-slate-800 px-2 py-2 text-slate-300">
          <div class="flex h-10 items-center gap-2 border-b border-slate-700 px-1.5 pb-2">
            <img src="/capgo.webp" alt="" class="h-6 w-6">
            <strong class="text-[0.78rem] font-semibold text-slate-100">Capgo</strong>
          </div>

          <div class="mt-2 flex items-center gap-2 rounded-md border border-slate-600 bg-slate-900/40 px-2 py-1.5">
            <span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-600 text-[0.5rem] font-bold text-slate-100">AC</span>
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-[0.58rem] text-slate-100">Acme organization</strong>
              <span class="block text-[0.45rem] text-slate-400">{{ t('organization') }}</span>
            </span>
            <IconChevronDown class="h-3 w-3" />
          </div>

          <span class="mt-3 px-2 text-[0.42rem] font-bold uppercase tracking-[0.14em] text-slate-500">{{ t('pages') }}</span>
          <div class="mt-1 grid gap-1">
            <div class="csa-dashboard-nav csa-console-click-target relative flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.56rem] font-semibold">
              <IconBarChart class="h-3.5 w-3.5" />{{ t('dashboard') }}
            </div>
            <div class="csa-apps-nav csa-console-click-target relative flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.56rem] font-semibold">
              <IconAppWindow class="h-3.5 w-3.5" />{{ t('apps') }}
            </div>
            <div class="flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.56rem] font-semibold text-slate-400">
              <IconKey class="h-3.5 w-3.5" />{{ t('api-keys') }}
            </div>
            <div class="flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.56rem] font-semibold text-slate-400">
              <IconFile class="h-3.5 w-3.5" />{{ t('documentation') }}
            </div>
          </div>

          <div class="mt-auto flex items-center gap-2 border-t border-slate-700 px-1.5 pt-2">
            <span class="grid h-6 w-6 place-items-center rounded-full bg-slate-600 text-[0.46rem] font-bold">JD</span>
            <span class="min-w-0"><strong class="block text-[0.52rem] text-slate-200">Jhon Doe</strong><span class="block truncate text-[0.42rem] text-slate-500">admin@acme.app</span></span>
          </div>
        </aside>

        <div class="csa-console-workspace relative min-w-0 overflow-hidden bg-blue-50">
          <section class="csa-console-dashboard-scene csa-console-scene">
            <div class="csa-console-topbar">
              <IconPanelLeft /><strong>{{ t('dashboard') }}</strong><span class="ml-auto">{{ t('free-trial') }}: <strong>{{ t('channel-console-assign-plan-active') }}</strong></span>
            </div>
            <div class="csa-console-dashboard-tabs">
              <span class="active"><IconBarChart />{{ t('dashboard-tab-usage') }}</span>
              <span><IconSignal />{{ t('update-delivery-latency') }} <small>{{ t('beta') }}</small></span>
              <span><IconBell />{{ t('notifications') }} <small>{{ t('beta') }}</small></span>
            </div>
            <div class="csa-console-page csa-console-usage-page">
              <div class="csa-console-usage-controls">
                <span class="active">{{ t('daily') }}</span><span>{{ t('cumulative') }}</span>
                <i />
                <span class="active">{{ t('billing-period') }}</span><span>{{ t('last-30-days') }}</span>
                <button type="button">
                  <IconRefresh />
                </button>
              </div>
              <div class="csa-console-usage-grid">
                <article class="csa-console-usage-card cyan">
                  <div><strong>{{ t('monthly-active') }}</strong><span>1,248 {{ t('units-users') }}</span></div>
                  <div class="csa-console-sparkline">
                    <i /><i /><i /><i /><i /><i /><i />
                  </div>
                </article>
                <article class="csa-console-usage-card blue">
                  <div><strong>{{ t('Storage') }}</strong><span>3.8 {{ t('units-gb') }}</span></div>
                  <div class="csa-console-sparkline">
                    <i /><i /><i /><i /><i /><i /><i />
                  </div>
                </article>
                <article class="csa-console-usage-card orange">
                  <div><strong>{{ t('Bandwidth') }}</strong><span>18.4 {{ t('units-gb') }}</span></div>
                  <div class="csa-console-sparkline">
                    <i /><i /><i /><i /><i /><i /><i />
                  </div>
                </article>
              </div>
            </div>
          </section>

          <section class="csa-console-apps-scene csa-console-scene">
            <div class="csa-console-topbar">
              <IconPanelLeft /><strong>{{ t('apps') }}</strong><span class="ml-auto">{{ t('free-trial') }}: <strong>{{ t('channel-console-assign-plan-active') }}</strong></span>
            </div>
            <div class="csa-console-page csa-console-list-page">
              <div class="csa-console-table csa-console-apps-table">
                <div class="csa-console-table-toolbar">
                  <div class="csa-console-reload">
                    <IconRefresh />{{ t('reload') }}
                  </div>
                  <span class="csa-console-add"><IconPlus />{{ t('add-one') }}</span>
                  <div class="csa-console-search">
                    <IconSearch />{{ t('search-by-name-or-app-id') }}
                  </div>
                </div>
                <div class="csa-console-app-grid csa-console-table-head">
                  <span>{{ t('name') }}</span><span>{{ t('last-version') }}</span><span>{{ t('last-upload') }}</span><span>{{ t('mau') }}</span><span>{{ t('app-perm') }}</span>
                </div>
                <div class="csa-console-app-grid csa-console-data-row relative">
                  <span class="csa-app-row csa-console-click-target flex items-center gap-2"><i class="csa-console-app-icon">A</i><strong>Acme Mobile</strong></span><span>1.1.0</span><span>Aug 23, 2026</span><span>1,248</span><span>Owner</span>
                </div>
                <div class="csa-console-app-grid csa-console-muted-row">
                  <span class="flex items-center gap-2"><i class="csa-console-app-icon csa-console-app-icon-alt">S</i><strong>Acme Staff</strong></span><span>2.4.1</span><span>Aug 19, 2026</span><span>143</span><span>Owner</span>
                </div>
              </div>
            </div>
          </section>

          <section class="csa-console-app-scene csa-console-scene">
            <div class="csa-console-topbar">
              <IconPanelLeft /><span>{{ t('apps') }}</span><i>/</i><strong>Acme Mobile</strong><span class="ml-auto">com.acme.mobile</span>
            </div>
            <div class="csa-console-app-tabs">
              <span class="active"><IconLayoutDashboard />{{ t('dashboard') }}</span><span><IconEye />{{ t('observe') }} <small>{{ t('beta') }}</small></span><span><IconSettings />{{ t('settings') }}</span><span><IconBox />{{ t('bundles') }}</span><span><IconSignal />{{ t('channels') }}</span><span class="csa-devices-tab-dashboard csa-console-click-target relative"><IconSmartphone />{{ t('devices') }}</span><span><IconBell />{{ t('notifications') }}</span><span><IconWrench />{{ t('builds') }}</span>
            </div>
            <div class="csa-console-device-tabs csa-console-app-dashboard-tabs">
              <span class="active">{{ t('dashboard-tab-usage') }}</span><span>{{ t('native') }}</span><span>{{ t('dashboard-tab-installs') }}</span><span>{{ t('active-bundle') }}</span>
            </div>
            <div class="csa-console-page csa-console-usage-page csa-console-app-overview">
              <div class="csa-console-usage-controls">
                <span class="active">{{ t('daily') }}</span><span>{{ t('cumulative') }}</span><i /><span class="active">{{ t('billing-period') }}</span><span>{{ t('last-30-days') }}</span>
              </div>
              <div class="csa-console-usage-grid">
                <article class="csa-console-usage-card cyan">
                  <div><strong>{{ t('monthly-active') }}</strong><span>1,248 {{ t('units-users') }}</span></div><div class="csa-console-sparkline">
                    <i /><i /><i /><i /><i /><i /><i />
                  </div>
                </article>
                <article class="csa-console-usage-card blue">
                  <div><strong>{{ t('Storage') }}</strong><span>3.8 {{ t('units-gb') }}</span></div><div class="csa-console-sparkline">
                    <i /><i /><i /><i /><i /><i /><i />
                  </div>
                </article>
                <article class="csa-console-usage-card orange">
                  <div><strong>{{ t('Bandwidth') }}</strong><span>18.4 {{ t('units-gb') }}</span></div><div class="csa-console-sparkline">
                    <i /><i /><i /><i /><i /><i /><i />
                  </div>
                </article>
              </div>
            </div>
          </section>

          <section class="csa-console-devices-scene csa-console-scene">
            <div class="csa-console-topbar">
              <IconPanelLeft /><span>{{ t('apps') }}</span><i>/</i><strong>Acme Mobile</strong><span class="ml-auto">com.acme.mobile</span>
            </div>
            <div class="csa-console-app-tabs">
              <span><IconLayoutDashboard />{{ t('dashboard') }}</span><span><IconEye />{{ t('observe') }}</span><span><IconSettings />{{ t('settings') }}</span><span><IconBox />{{ t('bundles') }}</span><span><IconSignal />{{ t('channels') }}</span><span class="active"><IconSmartphone />{{ t('devices') }}</span><span><IconBell />{{ t('notifications') }}</span><span><IconWrench />{{ t('builds') }}</span>
            </div>
            <div class="csa-console-page">
              <div>
                <p class="csa-console-eyebrow">
                  Acme Mobile
                </p><h3>{{ t('devices') }}</h3><p>{{ t('channel-console-assign-devices-description') }}</p>
              </div>
              <div class="csa-console-table csa-console-devices-table">
                <div class="csa-console-table-toolbar">
                  <div><IconSearch />{{ t('search-by-device-id') }}</div><span>30 days <IconChevronDown /></span>
                </div>
                <div class="csa-console-device-grid csa-console-table-head">
                  <span>{{ t('device-id') }}</span><span>{{ t('updated-at') }}</span><span>{{ t('platform') }}</span><span>{{ t('bundle') }}</span>
                </div>
                <div class="csa-console-device-grid csa-console-data-row relative">
                  <span class="csa-device-row csa-console-click-target"><strong>abc-123</strong></span><span>Just now</span><span>iOS 18.0</span><span class="text-blue-600">1.1.0</span>
                </div>
                <div class="csa-console-device-grid csa-console-muted-row">
                  <span><strong>def-456</strong></span><span>2 minutes ago</span><span>Android 15</span><span>1.1.0</span>
                </div>
                <div class="csa-console-device-grid csa-console-muted-row">
                  <span><strong>ghi-789</strong></span><span>8 minutes ago</span><span>iOS 17.6</span><span>1.0.4</span>
                </div>
              </div>
            </div>
          </section>

          <section class="csa-console-device-scene csa-console-scene">
            <div class="csa-console-topbar">
              <IconPanelLeft /><span>{{ t('apps') }}</span><i>/</i><span>Acme Mobile</span><i>/</i><strong>abc-123</strong>
            </div>
            <div class="csa-console-app-tabs csa-console-device-primary-tabs">
              <span><IconLayoutDashboard />{{ t('dashboard') }}</span><span><IconEye />{{ t('observe') }}</span><span><IconSettings />{{ t('settings') }}</span><span><IconBox />{{ t('bundles') }}</span><span><IconSignal />{{ t('channels') }}</span><span class="active"><IconSmartphone />{{ t('devices') }}</span><span><IconBell />{{ t('notifications') }}</span><span><IconWrench />{{ t('builds') }}</span>
            </div>
            <div class="csa-console-device-tabs">
              <span class="active">{{ t('info') }}</span><span>{{ t('deployments') }}</span><span>{{ t('logs') }}</span>
            </div>
            <div class="csa-console-device-page">
              <div class="csa-console-device-details">
                <div><span>{{ t('device-id') }}</span><strong>abc-123</strong></div>
                <div><span>{{ t('last-update') }}</span><strong>Aug 23, 2026, 7:04 PM</strong></div>
                <div><span>{{ t('platform') }}</span><strong>iOS</strong></div>
                <div><span>{{ t('plugin-version') }}</span><strong>7.0.0</strong></div>
                <div><span>{{ t('version') }}</span><strong class="text-blue-600">1.1.0</strong></div>
                <div><span>{{ t('default-channel') }}</span><strong>production</strong></div>
                <div class="csa-console-channel-row">
                  <span>{{ t('channel-link') }}</span>
                  <div class="relative">
                    <div class="csa-channel-trigger csa-console-click-target relative">
                      <strong class="csa-console-channel-none">{{ t('none') }}</strong><strong class="csa-console-channel-dev-value">dev</strong><IconChevronDown />
                    </div>
                    <div class="csa-console-channel-menu">
                      <div>{{ t('none') }}</div><div>production</div><div class="csa-channel-dev csa-console-click-target relative">
                        dev
                      </div><div>staging</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="csa-console-success-toast" role="status">
              <span><IconCheck /></span><div><strong>{{ t('channel-console-assign-success') }}</strong><p>{{ t('channel-console-assign-takeaway') }}</p></div>
            </div>
          </section>
        </div>
      </div>

      <span class="csa-console-click-pulse pointer-events-none absolute z-40" />
      <IconMousePointer class="csa-console-cursor pointer-events-none absolute z-50 h-5 w-5 fill-slate-950 text-white drop-shadow-[0_2px_2px_rgba(15,23,42,0.35)]" />
    </section>

    <footer v-if="embedded" class="flex items-center justify-between border-t border-slate-200 bg-white px-5 py-3 sm:px-6 dark:border-white/10 dark:bg-slate-950">
      <button
        type="button"
        class="d-btn d-btn-ghost d-btn-square h-10 min-h-10 w-10 shrink-0"
        data-test="channel-console-assign-back"
        :aria-label="t('button-back')"
        :title="t('button-back')"
        @click="emit('back')"
      >
        <IconArrowLeft class="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" class="d-btn d-btn-primary h-12 min-h-12 shrink-0 px-5" data-test="channel-console-assign-continue" @click="emit('continue')">
        {{ t('continue') }}
      </button>
    </footer>
  </main>
</template>

<style scoped>
.csa-console-shell {
  container-type: inline-size;
}

.csa-console-stage {
  --csa-console-stage-background: color-mix(in srgb, var(--color-base-200) 86%, #dbeafe);
  --csa-console-backdrop-background:
    radial-gradient(circle at 20% 10%, color-mix(in srgb, var(--color-base-100) 78%, transparent), transparent 38%),
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-base-100) 88%, #dbeafe),
      color-mix(in srgb, var(--color-base-200) 78%, #bfdbfe)
    );
  height: clamp(27rem, 52vh, 30rem);
  min-height: 27rem;
  background: var(--csa-console-stage-background);
}

@media (min-width: 851px) {
  .csa-console-shell-embedded .csa-console-stage {
    height: clamp(32rem, 55vh, 36rem);
    min-height: 32rem;
  }
}

.csa-console-backdrop {
  background: var(--csa-console-backdrop-background);
}

.csa-console-frame {
  grid-template-columns: clamp(7.2rem, 17%, 10rem) minmax(0, 1fr);
  will-change: transform, opacity;
}

.csa-console-scene {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  will-change: transform, opacity;
}

.csa-console-topbar {
  display: flex;
  flex: 0 0 auto;
  gap: 0.45rem;
  align-items: center;
  height: 2.65rem;
  padding: 0 0.9rem;
  color: #64748b;
  border-bottom: 1px solid #dbe3ee;
  background: rgb(248 250 252 / 96%);
  font-size: 0.56rem;
}

.csa-console-topbar > svg {
  width: 0.85rem;
  height: 0.85rem;
}

.csa-console-topbar strong {
  color: #334155;
}

.csa-console-topbar i {
  color: #94a3b8;
  font-style: normal;
}

.csa-console-page {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.7rem;
  min-height: 0;
  padding: 0.85rem 1rem;
}

.csa-console-dashboard-tabs {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 0 0 auto;
  gap: 0.35rem;
  height: 2.35rem;
  align-items: end;
  padding: 0 0.45rem;
  border-bottom: 1px solid rgb(191 219 254 / 80%);
  background: #f8fafc;
}

.csa-console-dashboard-tabs > span {
  display: inline-flex;
  gap: 0.25rem;
  align-items: center;
  height: 1.95rem;
  padding: 0 0.55rem;
  color: #64748b;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 0.32rem 0.32rem 0 0;
  font-size: 0.45rem;
  font-weight: 650;
}

.csa-console-dashboard-tabs > span.active {
  color: #3b82f6;
  border-color: rgb(191 219 254 / 75%);
  background: #eff6ff;
}

.csa-console-dashboard-tabs svg {
  width: 0.72rem;
  height: 0.72rem;
}

.csa-console-dashboard-tabs small,
.csa-console-app-tabs small {
  padding: 0.07rem 0.2rem;
  color: #0369a1;
  border: 1px solid rgb(14 165 233 / 35%);
  border-radius: 0.2rem;
  background: rgb(14 165 233 / 8%);
  font-size: 0.32rem;
  font-weight: 750;
  text-transform: uppercase;
}

.csa-console-usage-page {
  gap: 0.55rem;
  padding-top: 0.65rem;
}

.csa-console-usage-controls {
  display: flex;
  gap: 0.12rem;
  align-items: center;
  justify-content: flex-end;
  height: 1.8rem;
  color: #64748b;
  font-size: 0.4rem;
}

.csa-console-usage-controls > span {
  padding: 0.3rem 0.42rem;
  border-radius: 0.25rem;
  background: #e2e8f0;
  font-weight: 650;
}

.csa-console-usage-controls > span.active {
  color: #0f172a;
  background: #fff;
  box-shadow: 0 0.1rem 0.3rem rgb(15 23 42 / 10%);
}

.csa-console-usage-controls > i {
  width: 0.4rem;
}

.csa-console-usage-controls > button {
  display: grid;
  width: 1.35rem;
  height: 1.35rem;
  margin-left: 0.15rem;
  color: #64748b;
  border-radius: 0.25rem;
  background: #fff;
  box-shadow: 0 0.1rem 0.3rem rgb(15 23 42 / 10%);
  place-items: center;
}

.csa-console-usage-controls svg {
  width: 0.65rem;
  height: 0.65rem;
}

.csa-console-usage-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.55rem;
  min-height: 0;
}

.csa-console-usage-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 11.6rem;
  padding: 0.75rem;
  overflow: hidden;
  border: 1px solid #d7e0eb;
  border-radius: 0.55rem;
  background: #fff;
  box-shadow: 0 0.3rem 0.8rem rgb(15 23 42 / 6%);
}

.csa-console-usage-card > div:first-child {
  display: grid;
  gap: 0.15rem;
}

.csa-console-usage-card strong {
  color: #172033;
  font-size: 0.62rem;
}

.csa-console-usage-card span {
  color: #64748b;
  font-size: 0.46rem;
}

.csa-console-sparkline {
  display: flex;
  flex: 1;
  gap: 0.18rem;
  align-items: end;
  margin-top: 0.75rem;
  padding: 0 0.15rem 0.28rem;
  border-bottom: 1px solid #e2e8f0;
}

.csa-console-sparkline i {
  flex: 1;
  height: 42%;
  border-radius: 0.12rem 0.12rem 0 0;
  background: #06b6d4;
  opacity: 0.86;
}

.csa-console-usage-card.blue .csa-console-sparkline i {
  background: #3b82f6;
}

.csa-console-usage-card.orange .csa-console-sparkline i {
  background: #f97316;
}

.csa-console-sparkline i:nth-child(2) {
  height: 58%;
}
.csa-console-sparkline i:nth-child(3) {
  height: 48%;
}
.csa-console-sparkline i:nth-child(4) {
  height: 72%;
}
.csa-console-sparkline i:nth-child(5) {
  height: 64%;
}
.csa-console-sparkline i:nth-child(6) {
  height: 82%;
}
.csa-console-sparkline i:nth-child(7) {
  height: 76%;
}

.csa-console-page h3 {
  color: #0f172a;
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.2;
}

.csa-console-page p:not(.csa-console-eyebrow) {
  margin-top: 0.18rem;
  color: #64748b;
  font-size: 0.52rem;
}

.csa-console-eyebrow {
  margin-bottom: 0.16rem;
  color: #3b82f6;
  font-size: 0.42rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.csa-console-metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.55rem;
}

.csa-console-metric-grid > div {
  display: grid;
  gap: 0.12rem;
  padding: 0.65rem;
  border: 1px solid #d7e0eb;
  border-radius: 0.5rem;
  background: #fff;
  box-shadow: 0 0.28rem 0.7rem rgb(15 23 42 / 5%);
}

.csa-console-metric-grid span {
  color: #64748b;
  font-size: 0.46rem;
}

.csa-console-metric-grid strong {
  color: #172033;
  font-size: 0.92rem;
}

.csa-console-metric-grid small {
  color: #64748b;
  font-size: 0.42rem;
}

.csa-console-dashboard-card {
  display: flex;
  flex: 1;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  min-height: 0;
  padding: 0.7rem;
  border: 1px solid #d7e0eb;
  border-radius: 0.5rem;
  background: #fff;
}

.csa-console-dashboard-card > div:first-child {
  display: grid;
  gap: 0.12rem;
  color: #172033;
  font-size: 0.55rem;
}

.csa-console-dashboard-card > div:first-child span {
  color: #64748b;
  font-size: 0.44rem;
}

.csa-console-bars {
  display: flex;
  gap: 0.28rem;
  align-items: end;
  width: 56%;
  height: 100%;
  min-height: 4.3rem;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid #dbe5f1;
}

.csa-console-bars i {
  flex: 1;
  height: 52%;
  border-radius: 0.16rem 0.16rem 0 0;
  background: linear-gradient(180deg, #60a5fa, #2563eb);
}

.csa-console-bars i:nth-child(2) {
  height: 66%;
}
.csa-console-bars i:nth-child(3) {
  height: 45%;
}
.csa-console-bars i:nth-child(4) {
  height: 76%;
}
.csa-console-bars i:nth-child(5) {
  height: 58%;
}
.csa-console-bars i:nth-child(6) {
  height: 84%;
}
.csa-console-bars i:nth-child(7) {
  height: 72%;
}
.csa-console-bars i:nth-child(8) {
  height: 94%;
}

.csa-console-table {
  overflow: hidden;
  border: 1px solid #cfd9e6;
  border-radius: 0.48rem;
  background: #fff;
  box-shadow: 0 0.35rem 0.8rem rgb(15 23 42 / 6%);
}

.csa-console-table-toolbar {
  display: flex;
  gap: 0.35rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.48rem 0.55rem;
  border-bottom: 1px solid #e2e8f0;
}

.csa-console-table-toolbar > .csa-console-search {
  width: min(13rem, 45%);
  margin-left: auto;
}

.csa-console-table-toolbar > .csa-console-add {
  color: #64748b;
  border-color: transparent;
  background:
    linear-gradient(#fff, #fff) padding-box,
    linear-gradient(90deg, #06b6d4, #a855f7) border-box;
}

.csa-console-table-toolbar > div,
.csa-console-table-toolbar > span {
  display: flex;
  gap: 0.32rem;
  align-items: center;
  height: 1.55rem;
  padding: 0 0.48rem;
  color: #64748b;
  border: 1px solid #d7e0eb;
  border-radius: 0.35rem;
  background: #fff;
  font-size: 0.45rem;
}

.csa-console-table-toolbar > span {
  color: #fff;
  border-color: #2563eb;
  background: #2563eb;
  font-weight: 700;
}

.csa-console-table-toolbar svg {
  width: 0.65rem;
  height: 0.65rem;
}

.csa-console-app-grid,
.csa-console-device-grid {
  display: grid;
  align-items: center;
  min-height: 2.65rem;
  padding: 0 0.6rem;
  color: #475569;
  border-bottom: 1px solid #e6ebf2;
  font-size: 0.47rem;
}

.csa-console-app-grid {
  grid-template-columns: 1.6fr 0.75fr 0.95fr 0.55fr 0.8fr;
}

.csa-console-device-grid {
  grid-template-columns: 1.25fr 1fr 0.9fr 0.7fr;
}

.csa-console-table-head {
  min-height: 1.75rem;
  color: #64748b;
  background: #f8fafc;
  font-size: 0.42rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.csa-console-data-row {
  color: #334155;
  background: #fff;
  cursor: default;
}

.csa-console-data-row:hover {
  background: #f8fbff;
}

.csa-app-row,
.csa-device-row {
  width: max-content;
  max-width: 100%;
  color: #1e293b;
  cursor: default;
}

.csa-console-muted-row {
  color: #718096;
  background: #fff;
}

.csa-console-app-icon {
  display: grid;
  width: 1.45rem;
  height: 1.45rem;
  flex: 0 0 auto;
  color: #fff;
  border-radius: 0.42rem;
  background: linear-gradient(135deg, #2dd4bf, #2563eb);
  font-size: 0.55rem;
  font-style: normal;
  font-weight: 800;
  place-items: center;
}

.csa-console-app-icon-alt {
  background: linear-gradient(135deg, #f59e0b, #ef4444);
}

.csa-console-app-tabs {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 0 0 auto;
  gap: 0.14rem;
  align-items: end;
  height: 2.35rem;
  padding: 0 0.25rem;
  overflow: hidden;
  border-bottom: 1px solid #bfd2e9;
  background: #f8fafc;
}

.csa-console-app-tabs > span {
  display: inline-flex;
  gap: 0.24rem;
  align-items: center;
  height: 1.95rem;
  padding: 0 0.38rem;
  color: #64748b;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 0.32rem 0.32rem 0 0;
  font-size: 0.43rem;
  font-weight: 650;
  white-space: nowrap;
}

.csa-console-app-tabs > span.active {
  color: #3b82f6;
  border-color: #bfd2e9;
  background: #eff6ff;
}

.csa-console-app-tabs svg {
  width: 0.68rem;
  height: 0.68rem;
}

.csa-console-app-overview {
  padding-top: 0.55rem;
}

.csa-console-health {
  display: inline-flex;
  gap: 0.26rem;
  align-items: center;
  color: #047857;
  font-size: 0.5rem;
  font-weight: 700;
}

.csa-console-health svg {
  width: 0.78rem;
  height: 0.78rem;
  padding: 0.1rem;
  color: #fff;
  border-radius: 999px;
  background: #10b981;
}

.csa-console-device-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 0.35rem;
  height: 2rem;
  align-items: center;
  padding: 0 0.7rem;
  border-bottom: 1px solid #dbe5f1;
  background: #eff6ff;
}

.csa-console-device-tabs span {
  padding: 0.28rem 0.5rem;
  color: #64748b;
  border-radius: 0.32rem;
  font-size: 0.45rem;
  font-weight: 650;
}

.csa-console-device-tabs span.active {
  color: #2563eb;
  border: 1px solid #bfdbfe;
  background: #fff;
  box-shadow: 0 0.16rem 0.35rem rgb(15 23 42 / 6%);
}

.csa-console-device-page {
  flex: 1;
  min-height: 0;
  padding: 0.65rem 1rem 0.75rem;
}

.csa-console-device-details {
  overflow: visible;
  border: 1px solid #cfd9e6;
  border-radius: 0.48rem;
  background: #fff;
  box-shadow: 0 0.35rem 0.8rem rgb(15 23 42 / 6%);
}

.csa-console-device-details > div {
  display: grid;
  grid-template-columns: minmax(7rem, 42%) minmax(0, 1fr);
  align-items: center;
  min-height: 2.15rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid #e6ebf2;
  font-size: 0.48rem;
}

.csa-console-device-details > div:last-child {
  border-bottom: 0;
}

.csa-console-device-details > div > span {
  color: #64748b;
}

.csa-console-device-details > div > strong,
.csa-console-device-details > div > div {
  justify-self: end;
  color: #1e293b;
}

.csa-console-channel-row {
  position: relative;
  z-index: 12;
}

.csa-channel-trigger {
  display: flex;
  gap: 0.26rem;
  align-items: center;
  justify-content: flex-end;
  min-width: 4.2rem;
  height: 1.45rem;
  padding: 0 0.42rem;
  color: #334155;
  border: 1px solid #cbd5e1;
  border-radius: 0.3rem;
  background: #fff;
  font-size: 0.46rem;
}

.csa-channel-trigger > strong {
  position: absolute;
  right: 1.2rem;
}

.csa-channel-trigger svg {
  width: 0.62rem;
  height: 0.62rem;
  margin-left: auto;
}

.csa-console-channel-dev-value {
  color: #2563eb;
}

.csa-console-channel-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.22rem);
  z-index: 20;
  width: 6.5rem;
  padding: 0.22rem;
  color: #334155;
  border: 1px solid #d7e0eb;
  border-radius: 0.38rem;
  background: #fff;
  box-shadow: 0 0.55rem 1.4rem rgb(15 23 42 / 18%);
  font-size: 0.48rem;
}

.csa-console-channel-menu > div {
  padding: 0.34rem 0.45rem;
  border-radius: 0.25rem;
}

.csa-console-channel-menu > div:hover,
.csa-channel-dev {
  color: #1d4ed8;
  background: #eff6ff;
}

.csa-console-success-toast {
  position: absolute;
  top: 5.25rem;
  right: 0.75rem;
  z-index: 30;
  display: flex;
  gap: 0.48rem;
  align-items: flex-start;
  width: 12.5rem;
  padding: 0.62rem;
  color: #334155;
  border: 1px solid #bbf7d0;
  border-radius: 0.5rem;
  background: #fff;
  box-shadow: 0 0.65rem 1.8rem rgb(15 23 42 / 18%);
  font-size: 0.5rem;
  will-change: transform, opacity;
}

.csa-console-success-toast > span {
  display: grid;
  width: 1.2rem;
  height: 1.2rem;
  flex: 0 0 auto;
  color: #fff;
  border-radius: 999px;
  background: #10b981;
  place-items: center;
}

.csa-console-success-toast svg {
  width: 0.72rem;
  height: 0.72rem;
  stroke-width: 3;
}

.csa-console-success-toast strong {
  color: #14532d;
  font-size: 0.54rem;
}

.csa-console-success-toast p {
  margin-top: 0.1rem;
  color: #64748b;
  font-size: 0.44rem;
  line-height: 1.35;
}

.csa-console-click-target,
.csa-console-cursor,
.csa-console-click-pulse {
  will-change: transform, opacity;
}

.csa-console-cursor,
.csa-console-click-pulse {
  position: absolute;
  top: 0;
  left: 0;
}

.csa-console-cursor {
  margin-top: -0.12rem;
  margin-left: -0.12rem;
  transform-origin: 17% 20%;
}

.csa-console-click-pulse {
  width: 1.6rem;
  height: 1.6rem;
  border: 2px solid rgb(96 165 250 / 80%);
  border-radius: 999px;
  background: rgb(147 197 253 / 18%);
  pointer-events: none;
}

@container (max-width: 720px) {
  .csa-console-frame {
    grid-template-columns: 7.25rem minmax(0, 1fr);
  }

  .csa-console-sidebar {
    padding-inline: 0.35rem;
  }

  .csa-console-topbar,
  .csa-console-page {
    padding-inline: 0.65rem;
  }

  .csa-console-app-tabs > span {
    padding-inline: 0.26rem;
  }

  .csa-console-app-tabs > span:nth-last-child(-n + 2) {
    display: none;
  }
}
</style>
