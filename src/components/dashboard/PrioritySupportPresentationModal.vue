<script setup lang="ts">
import { gsap } from 'gsap'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconGithub from '~icons/lucide/github'
import IconGithubMark from '~icons/octicon/mark-github-24'
import { pushEvent } from '~/services/posthog'
import { getLocalConfig } from '~/services/supabase'
import PrioritySupportStory from './PrioritySupportStory.vue'

const props = defineProps<{ open: boolean, supportTier: 'paying' | 'trial' }>()
const emit = defineEmits<{ close: [], linkGithub: [] }>()

const { t } = useI18n()
const config = getLocalConfig()
const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const SLIDE_COUNT = 3
const cur = ref(0)
const deckEl = ref<HTMLElement | null>(null)
const modalEl = ref<HTMLElement | null>(null)
const isFirst = computed(() => cur.value === 0)
const isLast = computed(() => cur.value === SLIDE_COUNT - 1)
const slideTwoLead = computed(() => t(props.supportTier === 'trial' ? 'priority-support-s2-trial-lead' : 'priority-support-s2-paying-lead'))
const slideTwoChip = computed(() => t(props.supportTier === 'trial' ? 'priority-support-s2-trial-chip' : 'priority-support-s2-paying-chip'))

let animating = false
let issuePulse: gsap.core.Timeline | null = null
let issuePulseTarget: HTMLElement | null = null
let issuePulseRing: HTMLElement | null = null
let previousBodyOverflow = ''
let opener: HTMLElement | null = null

function getSlides(): HTMLElement[] {
  return deckEl.value ? Array.from(deckEl.value.querySelectorAll<HTMLElement>('.ps-slide')) : []
}

function track(event: string, props_: Record<string, string | number | boolean | null> = {}) {
  pushEvent(event, config.supaHost, props_)
}

function stopIssuePulse() {
  issuePulse?.kill()
  issuePulse = null
  if (issuePulseTarget)
    gsap.set(issuePulseTarget, { clearProps: 'transform' })
  if (issuePulseRing)
    gsap.set(issuePulseRing, { clearProps: 'opacity,transform,visibility' })
  issuePulseTarget = null
  issuePulseRing = null
}

function startIssuePulse(slide: HTMLElement) {
  stopIssuePulse()
  const button = slide.querySelector<HTMLElement>('.ps-new-issue')
  const ring = button?.querySelector<HTMLElement>('.ps-new-issue-pulse')
  if (!button || !ring || reduce)
    return

  issuePulseTarget = button
  issuePulseRing = ring
  gsap.set(ring, { autoAlpha: 0, scale: 0.94 })
  issuePulse = gsap.timeline({ repeat: -1, repeatDelay: 0.25 })
  issuePulse
    .to(button, {
      scale: 1.065,
      duration: 0.44,
      ease: 'sine.inOut',
    })
    .to(ring, {
      autoAlpha: 0.9,
      scale: 1,
      duration: 0.44,
      ease: 'sine.out',
    }, '<')
    .to(button, {
      scale: 1,
      duration: 0.56,
      ease: 'sine.inOut',
    })
    .to(ring, {
      autoAlpha: 0,
      scale: 1.23,
      duration: 0.56,
      ease: 'sine.out',
    }, '<')
}

function stopSlideAnimations(index: number) {
  if (index === 1)
    stopIssuePulse()
}

function focusSlideHeading(slide: HTMLElement) {
  if (!props.open || !slide.isConnected)
    return

  slide.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}

function enter(index: number) {
  const slide = getSlides()[index]
  if (!slide)
    return

  if (!reduce) {
    const copy = [
      slide.querySelector('h2'),
      slide.querySelector('.ps-lead'),
      ...Array.from(slide.querySelectorAll('.ps-item')),
      slide.querySelector('.ps-chip'),
    ].filter(Boolean) as Element[]
    gsap.from(copy, { autoAlpha: 0, y: 14, duration: 0.6, stagger: 0.1, ease: 'power3.out', clearProps: 'all' })
    gsap.from(slide.querySelector('.ps-left-artifact'), { autoAlpha: 0, y: 12, duration: 0.5, clearProps: 'all' })
    const cta = slide.querySelector('.ps-cta-wrap')
    if (cta)
      gsap.from(cta, { autoAlpha: 0, duration: 0.32, delay: 0.28, ease: 'power1.out', clearProps: 'all' })
  }

  if (index === 1)
    startIssuePulse(slide)
}

async function go(to: number, direction: number) {
  if (animating || to < 0 || to >= SLIDE_COUNT || to === cur.value)
    return

  const slides = getSlides()
  const fromSlide = slides[cur.value]
  const toSlide = slides[to]
  if (!fromSlide || !toSlide)
    return

  stopSlideAnimations(cur.value)

  if (reduce) {
    fromSlide.classList.remove('show')
    gsap.set(fromSlide, { zIndex: 1, autoAlpha: 0 })
    toSlide.classList.add('show')
    gsap.set(toSlide, { zIndex: 2, autoAlpha: 1, xPercent: 0 })
    cur.value = to
    track('priority_support_slide_viewed', { slide: to + 1 })
    enter(to)
    await nextTick()
    focusSlideHeading(toSlide)
    return
  }

  animating = true
  toSlide.classList.add('show')
  gsap.set(toSlide, { zIndex: 2, autoAlpha: 1, xPercent: direction > 0 ? 100 : -100 })
  gsap.set(fromSlide, { zIndex: 2, autoAlpha: 1, xPercent: 0 })
  cur.value = to
  track('priority_support_slide_viewed', { slide: to + 1 })
  const timeline = gsap.timeline({
    onComplete() {
      fromSlide.classList.remove('show')
      gsap.set(fromSlide, { zIndex: 1, autoAlpha: 0, xPercent: 0 })
      gsap.set(toSlide, { zIndex: 2 })
      animating = false
    },
  })
  timeline.to(fromSlide, { xPercent: direction > 0 ? -100 : 100, duration: 0.42, ease: 'power2.inOut' }, 0)
  timeline.to(toSlide, { xPercent: 0, duration: 0.42, ease: 'power2.inOut' }, 0)
  enter(to)
  await nextTick()
  focusSlideHeading(toSlide)
}

function next() {
  go(cur.value + 1, 1)
}

function previous() {
  go(cur.value - 1, -1)
}

function close() {
  emit('close')
}

function linkGithub() {
  track('priority_support_link_github_clicked', { slide: cur.value + 1 })
  emit('linkGithub')
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open)
    return
  if (event.key === 'ArrowRight') {
    next()
  }
  else if (event.key === 'ArrowLeft') {
    previous()
  }
  else if (event.key === 'Escape') {
    close()
  }
  else if (event.key === 'Tab') {
    const focusable = modalEl.value?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
    if (!focusable?.length)
      return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const activeElement = document.activeElement
    const activeIndex = Array.from(focusable).indexOf(activeElement as HTMLElement)
    const shouldWrapFromUnlisted = activeElement === modalEl.value || !modalEl.value?.contains(activeElement)
    if (event.shiftKey && (activeIndex === 0 || shouldWrapFromUnlisted)) {
      event.preventDefault()
      last.focus()
    }
    else if (!event.shiftKey && (activeIndex === focusable.length - 1 || shouldWrapFromUnlisted)) {
      event.preventDefault()
      first.focus()
    }
  }
}

function initDeck() {
  const slides = getSlides()
  slides.forEach((slide, index) => {
    slide.classList.toggle('show', index === 0)
    gsap.set(slide, { autoAlpha: index === 0 ? 1 : 0, xPercent: 0, zIndex: index === 0 ? 2 : 1 })
  })
  cur.value = 0
  animating = false
  enter(0)
  track('priority_support_slide_viewed', { slide: 1 })
}

watch(() => props.open, async (open) => {
  if (open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeydown)
    track('priority_support_promo_opened')
    await nextTick()
    initDeck()
    modalEl.value?.focus()
  }
  else {
    stopIssuePulse()
    document.body.style.overflow = previousBodyOverflow
    window.removeEventListener('keydown', onKeydown)
    opener?.focus()
  }
}, { immediate: true })

onUnmounted(() => {
  stopIssuePulse()
  document.body.style.overflow = previousBodyOverflow
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="ps-fade">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 ps-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="t('priority-support-dialog-label')"
      @click.self="close"
    >
      <section ref="modalEl" class="ps-modal" tabindex="-1">
        <header class="ps-top">
          <div
            class="ps-dots"
            role="progressbar"
            :aria-label="t('priority-support-progress-label')"
            aria-valuemin="1"
            :aria-valuemax="SLIDE_COUNT"
            :aria-valuenow="cur + 1"
          >
            <span v-for="step in SLIDE_COUNT" :key="step" class="ps-dot" :class="{ on: cur === step - 1 }" aria-hidden="true" />
          </div>
          <button class="ps-x" type="button" :aria-label="t('priority-support-close')" @click="close">
            ✕
          </button>
        </header>

        <main ref="deckEl" class="ps-deck">
          <article class="ps-slide show" :inert="cur !== 0" :aria-hidden="cur !== 0">
            <div class="ps-grid ps-grid--story">
              <div class="ps-left ps-left--story">
                <div class="ps-texture" />
                <PrioritySupportStory class="ps-left-artifact" :active="cur === 0 && open" :support-tier="supportTier" />
              </div>
              <div class="ps-right ps-right--story">
                <h2 id="priority-support-slide-1-title" tabindex="-1">
                  {{ t('priority-support-s1-title') }}
                </h2>
                <p class="ps-lead">
                  {{ t('priority-support-s1-lead') }}
                </p>
                <div class="ps-list">
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s1-item1') }}
                  </div>
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s1-item2') }}
                  </div>
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s1-item3') }}
                  </div>
                </div>
                <div class="ps-chip">
                  {{ t('priority-support-s1-chip') }}
                </div>
              </div>
            </div>
          </article>

          <article class="ps-slide" :inert="cur !== 1" :aria-hidden="cur !== 1">
            <div class="ps-grid">
              <div class="ps-left ps-left--browser" aria-hidden="true">
                <div class="ps-texture" />
                <div class="ps-browser ps-left-artifact">
                  <div class="ps-chrome">
                    <span /><span /><span /><b>github.com/Cap-go/capacitor-social-login/issues</b>
                  </div>
                  <div class="ps-github-head">
                    <IconGithub /><span>Cap-go</span><b>/</b><strong>capacitor-social-login</strong><em>Public</em>
                  </div>
                  <div class="ps-github-tabs">
                    <span>Code</span><span class="selected">Issues <b>12</b></span><span>Pull requests</span>
                  </div>
                  <div class="ps-github-toolbar">
                    <i>is:<mark>issue</mark> state:<mark>open</mark></i><span class="ps-new-issue"><span class="ps-new-issue-pulse" aria-hidden="true" /><span class="ps-new-issue-label">{{ t('priority-support-story-new-issue') }}</span></span>
                  </div>
                  <div class="ps-github-row featured">
                    <span class="ps-open-dot" /><div><strong>{{ t('priority-support-demo-issue-primary') }}</strong><small>#324 · {{ t('priority-support-demo-opened-now') }} · <b>{{ t('priority-support-story-bug') }}</b></small></div>
                  </div>
                  <div class="ps-github-row">
                    <span class="ps-open-dot" /><div><strong>{{ t('priority-support-demo-issue-secondary') }}</strong><small>#321 · {{ t('priority-support-demo-opened-two-days') }}</small></div>
                  </div>
                  <div class="ps-github-row">
                    <span class="ps-open-dot" /><div><strong>{{ t('priority-support-demo-issue-third') }}</strong><small>#319 · {{ t('priority-support-demo-opened-week') }}</small></div>
                  </div>
                  <div class="ps-github-row">
                    <span class="ps-open-dot" /><div><strong>{{ t('priority-support-demo-issue-fourth') }}</strong><small>#316 · {{ t('priority-support-demo-opened-week') }}</small></div>
                  </div>
                  <div class="ps-github-row">
                    <span class="ps-open-dot" /><div><strong>{{ t('priority-support-demo-issue-fifth') }}</strong><small>#311 · {{ t('priority-support-demo-opened-month') }}</small></div>
                  </div>
                </div>
              </div>
              <div class="ps-right">
                <h2 id="priority-support-slide-2-title" tabindex="-1">
                  {{ t('priority-support-s2-title') }}
                </h2>
                <p class="ps-lead">
                  {{ slideTwoLead }}
                </p>
                <div class="ps-list">
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s2-item1') }}
                  </div>
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s2-item2') }}
                  </div>
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s2-item3') }}
                  </div>
                </div>
                <div class="ps-chip">
                  {{ slideTwoChip }}
                </div>
              </div>
            </div>
          </article>

          <article class="ps-slide" :inert="cur !== 2" :aria-hidden="cur !== 2">
            <div class="ps-grid">
              <div class="ps-left ps-left--link" aria-hidden="true">
                <div class="ps-texture" />
                <div class="ps-link-card ps-left-artifact">
                  <div class="ps-account ps-account--github">
                    <IconGithub /><b>GitHub</b><small>{{ t('priority-support-story-github-handle') }}</small>
                  </div>
                  <div class="ps-link-connector">
                    <span>✓</span>
                  </div>
                  <div class="ps-account ps-account--capgo">
                    <span>✦</span><b>Capgo</b><small>{{ t('priority-support-story-priority-support') }}</small>
                  </div>
                </div>
                <div class="ps-link-caption">
                  {{ t('priority-support-s3-caption') }}
                </div>
              </div>
              <div class="ps-right">
                <h2 id="priority-support-slide-3-title" tabindex="-1">
                  {{ t('priority-support-s3-title') }}
                </h2>
                <p class="ps-lead">
                  {{ t('priority-support-s3-lead') }}
                </p>
                <div class="ps-list">
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s3-item1') }}
                  </div>
                  <div class="ps-item">
                    <span class="ps-check">✓</span>{{ t('priority-support-s3-item2') }}
                  </div>
                </div>
                <div class="ps-cta-wrap">
                  <button type="button" class="d-btn ps-cta ps-cta--github" @click="linkGithub">
                    <IconGithubMark class="ps-cta-icon" aria-hidden="true" />
                    <span>{{ t('priority-support-promo-cta') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </article>
        </main>

        <footer class="ps-foot">
          <button type="button" class="ps-ghost" :disabled="isFirst" @click="previous">
            ← {{ t('priority-support-back') }}
          </button>
          <button v-if="!isLast" type="button" class="ps-next" @click="next">
            {{ t('priority-support-next') }} →
          </button>
          <span v-else />
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
@property --ps-rainbow-angle {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}

@keyframes ps-rainbow-orbit {
  to {
    --ps-rainbow-angle: 1turn;
  }
}

.ps-fade-enter-active,
.ps-fade-leave-active {
  transition: opacity 0.25s ease;
}
.ps-fade-enter-from,
.ps-fade-leave-to {
  opacity: 0;
}

.ps-overlay {
  align-items: flex-start;
  overflow-y: auto;
  background: rgba(2, 8, 18, 0.72);
  backdrop-filter: blur(3px);
}
.ps-modal {
  --ps-surface: #ffffff;
  --ps-border: #e3e8f0;
  --ps-heading: #0f172a;
  --ps-text: #334155;
  --ps-muted: #5b6b82;
  --ps-dot: #64748b;
  --ps-dot-active: #0878c9;
  --ps-x: #64748b;
  --ps-ghost-border: #cbd5e1;
  --ps-ghost-text: #475569;
  --ps-chip-bg: rgba(17, 158, 255, 0.1);
  --ps-chip-border: rgba(17, 158, 255, 0.38);
  --ps-chip-text: #0c87e0;
  --ps-check-bg: rgba(17, 158, 255, 0.1);
  --ps-check-border: rgba(17, 158, 255, 0.4);
  --ps-check-text: #0c87e0;
  --ps-modal-shadow: 0 30px 80px rgba(15, 23, 42, 0.26);
  --ps-stage: radial-gradient(120% 120% at 35% 25%, #eef5ff 0%, #e3eefb 55%, #dbe8f8 100%);
  --ps-stage-text: #1e293b;
  --ps-stage-shadow: none;
  --ps-texture-dot: rgba(15, 23, 42, 0.06);
  --ps-card: rgba(255, 255, 255, 0.88);
  --ps-card-border: rgba(15, 23, 42, 0.13);
  --ps-card-shadow: 0 16px 40px rgba(15, 23, 42, 0.16);
  --ps-card-text: #1f2937;
  --ps-card-muted: #64748b;
  --ps-gh-bg: #ffffff;
  --ps-gh-subtle: #f6f8fa;
  --ps-gh-border: #d0d7de;
  --ps-gh-text: #1f2328;
  --ps-gh-muted: #57606a;
  --ps-gh-link: #0969da;

  width: 1080px;
  max-width: 100%;
  flex: none;
  isolation: isolate;
  overflow: hidden;
  border: 1px solid var(--ps-border);
  border-radius: 20px;
  margin-block: auto;
  background: var(--ps-surface);
  box-shadow: var(--ps-modal-shadow);
  clip-path: inset(0 round 20px);
}
.ps-modal:focus {
  outline: none;
}
.dark .ps-modal {
  --ps-surface: #0b1424;
  --ps-border: #16233a;
  --ps-heading: #ffffff;
  --ps-text: #e2e8f0;
  --ps-muted: #94a3b8;
  --ps-dot: #64748b;
  --ps-dot-active: #38bdf8;
  --ps-x: #94a3b8;
  --ps-ghost-border: #1e293b;
  --ps-ghost-text: #94a3b8;
  --ps-chip-bg: rgba(17, 158, 255, 0.16);
  --ps-chip-border: rgba(17, 158, 255, 0.5);
  --ps-chip-text: #7dd3fc;
  --ps-check-bg: rgba(17, 158, 255, 0.16);
  --ps-check-border: rgba(17, 158, 255, 0.5);
  --ps-check-text: #7dd3fc;
  --ps-modal-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  --ps-stage: radial-gradient(120% 120% at 35% 25%, #1f6fb2 0%, #0b3a63 55%, #062744 100%);
  --ps-stage-text: #ffffff;
  --ps-stage-shadow: 0 2px 16px rgba(0, 0, 0, 0.4);
  --ps-texture-dot: rgba(255, 255, 255, 0.07);
  --ps-card: rgba(8, 18, 31, 0.82);
  --ps-card-border: rgba(255, 255, 255, 0.16);
  --ps-card-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
  --ps-card-text: #eaf4ff;
  --ps-card-muted: #94a3b8;
  --ps-gh-bg: #0d1117;
  --ps-gh-subtle: #161b22;
  --ps-gh-border: #30363d;
  --ps-gh-text: #e6edf3;
  --ps-gh-muted: #8b949e;
  --ps-gh-link: #58a6ff;
}

.ps-top,
.ps-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
}
.ps-top {
  border-bottom: 1px solid var(--ps-border);
  border-radius: 19px 19px 0 0;
}
.ps-foot {
  border-top: 1px solid var(--ps-border);
}
.ps-dots {
  display: flex;
  gap: 7px;
}
.ps-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ps-dot);
  transition: all 0.3s;
}
.ps-dot.on {
  width: 22px;
  border-radius: 5px;
  background: var(--ps-dot-active);
}
.ps-x {
  border: 0;
  background: none;
  color: var(--ps-x);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.ps-ghost {
  border: 1px solid var(--ps-ghost-border);
  border-radius: 9px;
  padding: 8px 16px;
  background: transparent;
  color: var(--ps-ghost-text);
  font-size: 13px;
  cursor: pointer;
}
.ps-ghost:disabled {
  cursor: default;
  opacity: 0.35;
}
.ps-next {
  border: 0;
  border-radius: 9px;
  padding: 9px 18px;
  background: #119eff;
  color: #04121f;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.ps-deck {
  position: relative;
  height: 520px;
  overflow: hidden;
}
.ps-slide {
  position: absolute;
  inset: 0;
  opacity: 0;
}
.ps-slide.show {
  z-index: 2;
  opacity: 1;
}
.ps-grid {
  display: grid;
  grid-template-columns: 0.95fr 1.05fr;
  height: 100%;
}
.ps-grid--story {
  grid-template-columns: minmax(0, 1.55fr) minmax(250px, 0.75fr);
}
.ps-right--story {
  padding: 30px 26px;
}
.ps-left {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  overflow: hidden;
  background: var(--ps-stage);
}
.ps-texture {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--ps-texture-dot) 1px, transparent 1.4px);
  background-size: 18px 18px;
  mask: radial-gradient(70% 60% at 45% 38%, #000 30%, transparent 75%);
  opacity: 0.4;
}
.ps-right {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 32px 34px;
  background: var(--ps-surface);
}
.ps-right h2 {
  margin: 0 0 10px;
  color: var(--ps-heading);
  font-size: 23px;
  font-weight: 800;
  line-height: 1.16;
}
.ps-lead {
  margin: 0 0 18px;
  color: var(--ps-muted);
  font-size: 14.5px;
  line-height: 1.55;
}
.ps-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.ps-item {
  display: flex;
  align-items: center;
  gap: 11px;
  color: var(--ps-text);
  font-size: 14.5px;
}
.ps-check {
  display: flex;
  width: 22px;
  height: 22px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ps-check-border);
  border-radius: 50%;
  background: var(--ps-check-bg);
  color: var(--ps-check-text);
  font-size: 12px;
  font-weight: 800;
}
.ps-chip {
  align-self: flex-start;
  margin-top: 16px;
  border: 1px solid var(--ps-chip-border);
  border-radius: 999px;
  padding: 6px 13px;
  background: var(--ps-chip-bg);
  color: var(--ps-chip-text);
  font-size: 12px;
  font-weight: 700;
}
.ps-cta-wrap {
  position: relative;
  display: inline-flex;
  align-self: flex-start;
  isolation: isolate;
  margin-top: 24px;
}
.ps-cta-wrap::before {
  position: absolute;
  z-index: 0;
  border-radius: 12px;
  background: conic-gradient(from var(--ps-rainbow-angle), #58a6ff, #a371f7, #f778ba, #ffa657, #3fb950, #58a6ff);
  content: '';
  filter: blur(8px);
  inset: -5px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
}
.ps-cta-wrap:hover::before,
.ps-cta-wrap:focus-within::before {
  animation: ps-rainbow-orbit 2.2s linear infinite;
  opacity: 0.62;
}
.ps-cta {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 46px;
  border: 1px solid rgba(31, 35, 40, 0.15);
  border-radius: 8px;
  padding: 0 20px;
  background: #24292f;
  box-shadow:
    0 1px 0 rgba(31, 35, 40, 0.08),
    0 4px 12px rgba(31, 35, 40, 0.16);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  text-transform: none;
  cursor: pointer;
  transform-origin: center;
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.ps-cta:hover {
  border-color: rgba(31, 35, 40, 0.15);
  background: #24292f;
  transform: scale(1.02);
}
.ps-cta:active {
  background: #1b1f24;
  transform: scale(0.99);
}
.ps-cta svg {
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
}
.dark .ps-cta {
  border-color: #30363d;
  background: #21262d;
  box-shadow:
    0 1px 0 rgba(1, 4, 9, 0.4),
    0 4px 12px rgba(1, 4, 9, 0.28);
  color: #f0f6fc;
}
.dark .ps-cta:hover {
  border-color: #30363d;
  background: #21262d;
}
.dark .ps-cta:active {
  background: #161b22;
}
.ps-x:focus-visible,
.ps-ghost:focus-visible,
.ps-next:focus-visible {
  outline: 3px solid var(--ps-dot-active);
  outline-offset: 3px;
}
.ps-cta:focus-visible {
  outline: 2px solid #0969da;
  outline-offset: 3px;
}
.dark .ps-cta:focus-visible {
  outline-color: #58a6ff;
}

.ps-left--browser {
  padding: 20px;
}
.ps-browser {
  z-index: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--ps-gh-border);
  border-radius: 12px;
  background: var(--ps-gh-bg);
  box-shadow: var(--ps-card-shadow);
  color: var(--ps-gh-text);
}
.ps-chrome {
  display: flex;
  height: 34px;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border-bottom: 1px solid var(--ps-gh-border);
  background: var(--ps-gh-subtle);
  font-size: 8px;
}
.ps-chrome span {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #ff5f57;
}
.ps-chrome span:nth-child(2) {
  background: #febc2e;
}
.ps-chrome span:nth-child(3) {
  background: #28c840;
}
.ps-chrome b {
  min-width: 0;
  margin-left: 7px;
  overflow: hidden;
  color: var(--ps-gh-muted);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-github-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 13px 14px 10px;
  color: var(--ps-gh-muted);
  font-size: 9px;
}
.ps-github-head svg {
  width: 15px;
  color: var(--ps-gh-text);
}
.ps-github-head strong {
  color: var(--ps-gh-link);
}
.ps-github-head em {
  margin-left: 3px;
  border: 1px solid var(--ps-gh-border);
  border-radius: 9px;
  padding: 1px 5px;
  font-size: 7px;
  font-style: normal;
}
.ps-github-tabs {
  display: flex;
  gap: 15px;
  padding: 0 14px;
  border-bottom: 1px solid var(--ps-gh-border);
  font-size: 9px;
}
.ps-github-tabs span {
  padding: 7px 0;
  color: var(--ps-gh-muted);
}
.ps-github-tabs .selected {
  border-bottom: 2px solid #fd8c73;
  color: var(--ps-gh-text);
  font-weight: 700;
}
.ps-github-tabs b {
  border-radius: 9px;
  padding: 1px 4px;
  background: var(--ps-gh-border);
  font-size: 7px;
}
.ps-github-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 9px 11px;
  padding: 6px;
  border: 1px solid var(--ps-gh-border);
  border-radius: 6px;
  background: var(--ps-gh-subtle);
  font-size: 8px;
}
.ps-github-toolbar i {
  flex: 1;
  border: 1px solid var(--ps-gh-border);
  border-radius: 5px;
  padding: 5px 7px;
  background: var(--ps-gh-bg);
  color: var(--ps-gh-muted);
  font-style: normal;
}
.ps-github-toolbar mark {
  border-radius: 2px;
  padding: 0 1px;
  background: #b6dcff;
  color: #075cb5;
}
.dark .ps-github-toolbar mark {
  background: #1f6feb;
  color: #fff;
}
.ps-new-issue {
  position: relative;
  z-index: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(27, 31, 36, 0.15);
  border-radius: 6px;
  padding: 6px 9px;
  background: #1f883d;
  color: #fff;
  font-size: 8px;
  font-weight: 700;
  transform-origin: center;
  will-change: transform;
}
.ps-new-issue-pulse {
  position: absolute;
  z-index: -1;
  inset: -6px;
  border: 2px solid rgba(31, 136, 61, 0.8);
  border-radius: 9px;
  background: rgba(31, 136, 61, 0.2);
  pointer-events: none;
  transform-origin: center;
  will-change: opacity, transform;
}
.ps-new-issue-label {
  position: relative;
}
.ps-github-row {
  display: flex;
  gap: 8px;
  min-height: 46px;
  padding: 8px 13px;
  border-top: 1px solid var(--ps-gh-border);
}
.ps-github-row > div {
  min-width: 0;
}
.ps-github-row strong,
.ps-github-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-github-row strong {
  color: var(--ps-gh-text);
  font-size: 9px;
}
.ps-github-row small {
  margin-top: 3px;
  color: var(--ps-gh-muted);
  font-size: 7px;
}
.ps-github-row small b {
  border-radius: 9px;
  padding: 2px 4px;
  background: #d4c5f9;
  color: #5226a3;
}
.ps-github-row.featured strong {
  color: var(--ps-gh-link);
}
.ps-open-dot {
  width: 8px;
  height: 8px;
  flex: none;
  margin-top: 2px;
  border-radius: 50%;
  background: #1a7f37;
}

.ps-left--story {
  padding: 14px;
}

.ps-left--link {
  padding: 20px;
}
.ps-link-card {
  z-index: 1;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 11px;
}
.ps-account {
  display: grid;
  width: 126px;
  min-height: 130px;
  place-items: center;
  align-content: center;
  gap: 7px;
  border: 1px solid var(--ps-card-border);
  border-radius: 15px;
  padding: 18px 9px;
  background: var(--ps-card);
  box-shadow: var(--ps-card-shadow);
  color: var(--ps-card-text);
  text-align: center;
}
.ps-account svg {
  width: 32px;
}
.ps-account small {
  color: var(--ps-card-muted);
  font-size: 8px;
}
.ps-account--capgo > span {
  color: #119eff;
  font-size: 30px;
}
.ps-link-connector {
  position: relative;
  width: 42px;
  height: 2px;
  background: #119eff;
}
.ps-link-connector span {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  width: 23px;
  height: 23px;
  place-items: center;
  border-radius: 50%;
  background: #119eff;
  color: #04121f;
  font-size: 11px;
  font-weight: 800;
  transform: translate(-50%, -50%);
}
.ps-link-caption {
  z-index: 1;
  color: var(--ps-stage-text);
  font-size: 16px;
  font-weight: 800;
  text-align: center;
  text-shadow: var(--ps-stage-shadow);
}

@media (max-width: 640px) {
  .ps-deck {
    height: min(650px, calc(100dvh - 150px));
  }
  .ps-grid {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(250px, 0.92fr) minmax(0, 1.08fr);
  }
  .ps-grid--story {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(390px, 1.3fr) minmax(0, 0.7fr);
  }
  .ps-grid--story .ps-left--story {
    padding: 10px;
  }
  .ps-grid--story .ps-right--story {
    padding: 18px 24px;
  }
  .ps-right {
    overflow-y: auto;
    padding: 32px 34px;
  }
  .ps-left--browser,
  .ps-left--story,
  .ps-left--link {
    padding: 20px;
  }
  .ps-github-row:nth-of-type(n + 7) {
    display: none;
  }
  .ps-link-card {
    transform: scale(0.84);
  }
  .ps-link-caption {
    margin-top: -18px;
    font-size: 14px;
  }
}

@media (max-width: 380px) {
  .ps-right h2 {
    font-size: 21px;
  }
  .ps-lead,
  .ps-item {
    font-size: 13.5px;
  }
  .ps-list {
    gap: 9px;
  }
}

@media (max-width: 640px) and (max-height: 700px) {
  .ps-github-row:nth-of-type(n + 6) {
    display: none;
  }
}

@media (max-width: 640px) and (max-height: 500px) {
  .ps-deck {
    height: max(150px, calc(100dvh - 150px));
  }
  .ps-grid {
    grid-template-columns: 0.95fr 1.05fr;
    grid-template-rows: 1fr;
  }
  .ps-grid--story {
    grid-template-columns: 1fr;
  }
  .ps-grid--story .ps-right {
    display: none;
  }
  .ps-left--browser,
  .ps-left--story,
  .ps-left--link {
    padding: 12px;
  }
  .ps-right {
    padding: 18px 20px;
  }
  .ps-right h2 {
    font-size: 18px;
  }
  .ps-lead,
  .ps-item {
    font-size: 12px;
  }
}

@media (max-height: 600px) {
  .ps-deck {
    height: clamp(410px, calc(100dvh - 150px), 520px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ps-fade-enter-active,
  .ps-fade-leave-active,
  .ps-dot {
    transition: none;
  }
  .ps-new-issue {
    box-shadow: 0 0 0 4px rgba(31, 136, 61, 0.2);
  }
  .ps-cta {
    transition: none;
  }
  .ps-cta-wrap::before {
    transition: none;
  }
  .ps-cta-wrap:hover::before,
  .ps-cta-wrap:focus-within::before {
    animation: none;
  }
  .ps-cta:hover,
  .ps-cta:active {
    transform: none;
  }
}
</style>
