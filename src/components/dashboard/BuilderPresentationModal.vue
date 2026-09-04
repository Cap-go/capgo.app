<script setup lang="ts">
import { toSvg } from 'better-qr'
import { gsap } from 'gsap'
/**
 * BuilderPresentationModal
 *
 * A self-contained, 5-slide animated presentation for "Capgo Builder" (native
 * cloud builds), launched from the dashboard promo banner. Motion is driven by
 * GSAP for orchestrated entrances; idle ambient loops (phone float, glow,
 * shield ring, rocket flame) stay as scoped CSS. Honors prefers-reduced-motion.
 *
 * Self-contained modal pattern (mirrors DemoOnboardingModal.vue): `open` prop +
 * `close` emit, no global dialog store.
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { pushEvent } from '~/services/posthog'
import { getLocalConfig } from '~/services/supabase'
import { sanitizeHtml } from '~/utils/sanitize'

const props = defineProps<{ open: boolean, appId?: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const config = getLocalConfig()
const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const SLIDE_COUNT = 5
const cur = ref(0)
const launched = ref(false)
let animating = false
let buildTimer: ReturnType<typeof setTimeout> | null = null

const deckEl = ref<HTMLElement | null>(null)
const termPlatform = ref<'ios' | 'android'>('ios')

function svgToDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
// real, scannable QR → the public Capgo Builder page
let qrDataUrl = ''
try {
  qrDataUrl = svgToDataUrl(toSvg('https://capgo.app/native-build/', { margin: 1, moduleSize: 4, foreground: '#0a0d14', background: '#e8f3ff' }))
}
catch {
  qrDataUrl = ''
}

const isFirst = computed(() => cur.value === 0)
const isLast = computed(() => cur.value === SLIDE_COUNT - 1)

function getSlides(): HTMLElement[] {
  return deckEl.value ? Array.from(deckEl.value.querySelectorAll<HTMLElement>('.bp-slide')) : []
}

function track(event: string, props_: Record<string, string | number | boolean | null> = {}) {
  pushEvent(event, config.supaHost, props_)
}

function drawCheck(s: HTMLElement) {
  const ring = s.querySelector('.bp-s2-ring')
  const tick = s.querySelector('.bp-s2-tick')
  if (!ring)
    return
  gsap.set(ring, { strokeDashoffset: 327 })
  gsap.set(tick, { strokeDashoffset: 70 })
  gsap.to(ring, { strokeDashoffset: 0, duration: 0.85, ease: 'power2.out' })
  gsap.to(tick, { strokeDashoffset: 0, duration: 0.55, delay: 0.72, ease: 'power2.out' })
}

// ---------- slide 1: terminal hook (faithful port of the marketing build demo) ----------
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let termGen = 0
let termTimer: ReturnType<typeof setTimeout> | null = null

interface TermStep { t?: number, html?: string, replaceAll?: boolean, kind?: 'spin' | 'progress', label?: string, done?: string, ms?: number, size?: string }

function makeScript(p: 'ios' | 'android'): TermStep[] {
  const cmd = `<span class="prompt">$ </span><span class="cmd">npx @capgo/cli@latest build request</span> <span class="flag">--platform</span> <span class="val">${p}</span>`
  if (p === 'android') {
    return [
      { t: 0, html: `${cmd}<span class="bp-cursor"></span>` },
      { t: 700, replaceAll: true, html: `${cmd}\n<span class="ok">✔</span> Platform: <span class="val">Android</span>` },
      { t: 250, html: `\n<span class="ok">✔</span> App: <span class="val">com.acme.app</span>` },
      { t: 250, html: `\n<span class="lock">🔒</span> <span class="ghost">Keystore + service account never stored — used only during the build, then deleted.</span>` },
      { t: 400, html: `\n` },
      { t: 200, html: `\n<span class="ok">✔</span> Build job created  ·  job_id <span class="kw">b8e2d1</span>` },
      { t: 250, html: `\n` },
      { kind: 'spin', label: 'Zipping project', ms: 1100, done: `<span class="ok">✔</span> Project zipped  ·  <span class="kw">9.7 MB</span>` },
      { kind: 'progress', label: 'Uploading', size: '9.7 MB' },
      { t: 200, html: `\n` },
      { t: 220, html: `\n<span class="dim">[gradle]</span> :app:compileReleaseKotlin` },
      { t: 220, html: `\n<span class="dim">[gradle]</span> :app:processReleaseResources` },
      { t: 240, html: `\n<span class="dim">[gradle]</span> :app:packageRelease` },
      { t: 240, html: `\n<span class="dim">[gradle]</span> :app:signReleaseBundle  <span class="ghost">(keystore)</span>` },
      { t: 240, html: `\n<span class="dim">[gradle]</span> Producing <span class="val">app-release.aab</span>` },
      { t: 320, html: `\n<span class="ok">✔</span> Bundle signed  ·  <span class="kw">app-release.aab</span>` },
      { t: 380, html: `\n<span class="ok">✔</span> Uploaded to Play Console (Internal track)` },
      { t: 320, html: `\n` },
      { t: 250, html: `\n<span class="ok">━━━ Build completed successfully in 1m 22s ━━━</span>` },
    ]
  }
  return [
    { t: 0, html: `${cmd}<span class="bp-cursor"></span>` },
    { t: 700, replaceAll: true, html: `${cmd}\n<span class="ok">✔</span> Platform: <span class="val">iOS</span>` },
    { t: 250, html: `\n<span class="ok">✔</span> App: <span class="val">com.acme.app</span>` },
    { t: 250, html: `\n<span class="lock">🔒</span> <span class="ghost">Credentials never stored — used only during the build, then deleted.</span>` },
    { t: 400, html: `\n` },
    { t: 200, html: `\n<span class="ok">✔</span> Build job created  ·  job_id <span class="kw">9c4f7a</span>` },
    { t: 250, html: `\n` },
    { kind: 'spin', label: 'Zipping project', ms: 1100, done: `<span class="ok">✔</span> Project zipped  ·  <span class="kw">12.4 MB</span>` },
    { kind: 'progress', label: 'Uploading', size: '12.4 MB' },
    { t: 200, html: `\n` },
    { t: 200, html: `\n<span class="dim">[CapApp]</span> Compiling AppDelegate.swift` },
    { t: 220, html: `\n<span class="dim">[CapApp]</span> Compiling ContentView.swift` },
    { t: 240, html: `\n<span class="dim">[CapApp]</span> Linking App.framework` },
    { t: 240, html: `\n<span class="dim">[CapApp]</span> Signing main + 2 extensions` },
    { t: 260, html: `\n<span class="dim">[CapApp]</span> Creating App.xcarchive` },
    { t: 320, html: `\n<span class="ok">✔</span> Archive Succeeded` },
    { t: 380, html: `\n<span class="ok">✔</span> Uploaded to App Store Connect / TestFlight` },
    { t: 320, html: `\n` },
    { t: 250, html: `\n<span class="ok">━━━ Build completed successfully in 2m 41s ━━━</span>` },
  ]
}

function appendTrustedQrImage(container: HTMLElement) {
  if (!qrDataUrl)
    return

  const qrLine = container.querySelector('.bp-qr-line')
  if (!qrLine || qrLine.querySelector('img.bp-qr'))
    return

  const img = document.createElement('img')
  img.className = 'bp-qr'
  img.src = qrDataUrl
  img.alt = 'QR code — scan to install the build on your device'
  qrLine.insertBefore(img, qrLine.firstChild)
}

function renderTerminalBody(el: HTMLElement, html: string, withQr = false) {
  el.innerHTML = sanitizeHtml(html)
  if (withQr)
    appendTrustedQrImage(el)
  el.scrollTop = el.scrollHeight
}

function staticTerminal(p: 'ios' | 'android'): string {
  const cmd = `<span class="prompt">$ </span><span class="cmd">npx @capgo/cli@latest build request</span> <span class="flag">--platform</span> <span class="val">${p}</span>`
  if (p === 'android') {
    return `${cmd}\n<span class="ok">✔</span> Platform: <span class="val">Android</span>  ·  App: <span class="val">com.acme.app</span>\n<span class="lock">🔒</span> <span class="ghost">Keystore never stored — used only during the build, then deleted.</span>\n<span class="ok">✔</span> Bundle signed  ·  <span class="kw">app-release.aab</span>\n<span class="ok">✔</span> Uploaded to Play Console (Internal track)\n<span class="ok">━━━ Build completed successfully in 1m 22s ━━━</span>`
  }
  return `${cmd}\n<span class="ok">✔</span> Platform: <span class="val">iOS</span>  ·  App: <span class="val">com.acme.app</span>\n<span class="lock">🔒</span> <span class="ghost">Credentials never stored — used only during the build, then deleted.</span>\n<span class="ok">✔</span> Archive Succeeded\n<span class="ok">✔</span> Uploaded to App Store Connect / TestFlight\n<span class="ok">━━━ Build completed successfully in 2m 41s ━━━</span>`
}

function startTerminal(p: 'ios' | 'android') {
  termPlatform.value = p
  termGen += 1
  const myGen = termGen
  if (termTimer)
    clearTimeout(termTimer)
  const el = deckEl.value?.querySelector<HTMLElement>('.bp-term-body')
  if (!el)
    return
  if (reduce) {
    el.innerHTML = sanitizeHtml(staticTerminal(p))
    return
  }
  let buf = ''
  let idx = 0
  const script = makeScript(p)
  const render = (withQr = false) => {
    renderTerminalBody(el, buf, withQr)
  }
  const runSpin = (label: string, doneHtml: string, ms: number, onDone: () => void) => {
    let frame = 0
    let elapsed = 0
    const startBuf = buf
    const tick = () => {
      if (myGen !== termGen)
        return
      buf = `${startBuf}\n<span class="kw">${SPINNER[frame % SPINNER.length]}</span> ${label}…`
      render()
      frame += 1
      elapsed += 80
      if (elapsed >= ms) {
        buf = `${startBuf}\n${doneHtml}`
        render()
        onDone()
      }
      else {
        termTimer = setTimeout(tick, 80)
      }
    }
    tick()
  }
  const runProgress = (label: string, size: string, onDone: () => void) => {
    let pct = 0
    let frame = 0
    const startBuf = buf
    const tick = () => {
      if (myGen !== termGen)
        return
      const shown = Math.min(100, Math.round(pct))
      const filled = Math.round((shown * 24) / 100)
      const bar = '█'.repeat(filled) + '░'.repeat(24 - filled)
      buf = `${startBuf}\n<span class="kw">${SPINNER[frame % SPINNER.length]}</span> ${label}  <span class="dim">[</span><span class="val">${bar}</span><span class="dim">]</span>  <span class="val">${shown}%</span>`
      render()
      frame += 1
      pct += Math.max(1.6, (100 - pct) * 0.12)
      if (pct >= 99.5) {
        buf = `${startBuf}\n<span class="ok">✔</span> Upload complete  ·  <span class="val">${size} / ${size}</span>`
        render()
        onDone()
      }
      else {
        termTimer = setTimeout(tick, 55)
      }
    }
    tick()
  }
  const next = () => {
    if (myGen !== termGen)
      return
    if (idx >= script.length) {
      buf += '\n\n<span class="ok">✔</span> Ready to install on a real device:\n<span class="bp-qr-line"><span class="bp-qr-meta"><span class="kw">▸ Scan to install on your device</span><span class="dim">no cable, no Xcode — just your phone camera</span></span></span>'
      render(true)
      return
    }
    const s = script[idx++]
    if (s.kind === 'spin') {
      runSpin(s.label ?? '', s.done ?? '', s.ms ?? 1000, next)
      return
    }
    if (s.kind === 'progress') {
      runProgress(s.label ?? 'Uploading', s.size ?? '', next)
      return
    }
    termTimer = setTimeout(() => {
      if (myGen !== termGen)
        return
      buf = s.replaceAll ? (s.html ?? '') : buf + (s.html ?? '')
      render()
      next()
    }, s.t ?? 100)
  }
  render()
  termTimer = setTimeout(() => {
    if (myGen === termGen)
      next()
  }, 50)
}

function stopTerminal() {
  termGen += 1
  if (termTimer)
    clearTimeout(termTimer)
}

// staggered entrance for a slide's content, run after it lands
function enter(i: number) {
  if (i === 0)
    startTerminal(termPlatform.value)
  if (reduce)
    return
  const slides = getSlides()
  const s = slides[i]
  if (!s)
    return
  const right = [
    s.querySelector('h2'),
    s.querySelector('.bp-lead'),
    ...Array.from(s.querySelectorAll('.bp-item')),
    s.querySelector('.bp-chip'),
    s.querySelector('.bp-cta'),
  ].filter(Boolean) as Element[]
  gsap.from(right, { autoAlpha: 0, y: 14, duration: 0.6, stagger: 0.1, ease: 'power3.out', clearProps: 'all' })

  if (i === 0) {
    gsap.from(s.querySelector('.bp-terminal'), { autoAlpha: 0, y: 12, duration: 0.5, clearProps: 'all' })
  }
  else if (i === 1) {
    drawCheck(s)
    gsap.from(s.querySelector('.bp-leftcap'), { autoAlpha: 0, y: 8, duration: 0.55, delay: 0.78, clearProps: 'all' })
  }
  else if (i === 2) {
    gsap.from(s.querySelectorAll('.bp-phone'), { autoAlpha: 0, y: 22, scale: 0.92, duration: 0.78, stagger: 0.18, ease: 'back.out(1.5)', clearProps: 'transform,opacity', delay: 0.07 })
    gsap.from(s.querySelectorAll('.bp-pill'), { autoAlpha: 0, y: 10, duration: 0.55, stagger: 0.13, delay: 0.55, clearProps: 'all' })
    gsap.from(s.querySelector('.bp-cap'), { autoAlpha: 0, y: 8, duration: 0.55, delay: 0.78, clearProps: 'all' })
  }
  else if (i === 3) {
    gsap.from(s.querySelector('.bp-shieldwrap'), { autoAlpha: 0, scale: 0.78, duration: 0.78, ease: 'back.out(1.6)', clearProps: 'transform,opacity' })
    gsap.from(s.querySelector('.bp-leftcap'), { autoAlpha: 0, y: 8, duration: 0.55, delay: 0.43, clearProps: 'all' })
  }
  else if (i === 4) {
    gsap.from(s.querySelector('.bp-rocketbob'), { autoAlpha: 0, scale: 0.85, duration: 0.78, ease: 'back.out(1.5)', clearProps: 'transform,opacity' })
  }
}

function clearLaunch() {
  launched.value = false
  const deck = deckEl.value
  if (!deck)
    return
  const bob = deck.querySelector<HTMLElement>('.bp-rocketbob')
  if (bob)
    bob.style.cssText = ''
  const fl = deck.querySelector<HTMLElement>('.bp-flame')
  if (fl)
    fl.style.animation = ''
}

function go(to: number, dir: number) {
  if (animating || to < 0 || to >= SLIDE_COUNT || to === cur.value)
    return
  const slides = getSlides()
  const a = slides[cur.value]
  const b = slides[to]
  if (!a || !b)
    return
  if (cur.value === 4)
    clearLaunch()
  if (cur.value === 0)
    stopTerminal()

  if (reduce) {
    a.classList.remove('show')
    gsap.set(a, { zIndex: 1, autoAlpha: 0 })
    b.classList.add('show')
    gsap.set(b, { zIndex: 2, autoAlpha: 1, xPercent: 0 })
    cur.value = to
    track('builder_promo_slide_viewed', { slide: to + 1 })
    enter(to)
    return
  }

  animating = true
  // carousel: both slides stay fully opaque and slide horizontally together.
  // No opacity blending (so dark elements like the phone notch never bleed
  // through) and no dead gap (which read as lag in the sequential fade).
  b.classList.add('show')
  gsap.set(b, { zIndex: 2, autoAlpha: 1, xPercent: dir > 0 ? 100 : -100 })
  gsap.set(a, { zIndex: 2, autoAlpha: 1, xPercent: 0 })
  cur.value = to
  track('builder_promo_slide_viewed', { slide: to + 1 })
  const tl = gsap.timeline({
    onComplete() {
      a.classList.remove('show')
      gsap.set(a, { zIndex: 1, autoAlpha: 0, xPercent: 0 })
      gsap.set(b, { zIndex: 2 })
      animating = false
    },
  })
  tl.to(a, { xPercent: dir > 0 ? -100 : 100, duration: 0.42, ease: 'power2.inOut' }, 0)
  tl.to(b, { xPercent: 0, duration: 0.42, ease: 'power2.inOut' }, 0)
  enter(to)
}

function next() {
  go(cur.value + 1, 1)
}
function prev() {
  go(cur.value - 1, -1)
}

function startBuild() {
  track('builder_promo_cta_clicked', { slide: cur.value + 1 })
  const dest = props.appId
    ? `/app/${encodeURIComponent(props.appId)}/builds?page=1&sort_created_at=desc`
    : '/apps'
  if (reduce) {
    close()
    router.push(dest)
    return
  }
  launched.value = true
  if (buildTimer)
    clearTimeout(buildTimer)
  buildTimer = setTimeout(() => {
    buildTimer = null
    close()
    router.push(dest)
  }, 1000)
}

function onKey(e: KeyboardEvent) {
  if (!props.open)
    return
  if (e.key === 'ArrowRight')
    next()
  else if (e.key === 'ArrowLeft')
    prev()
  else if (e.key === 'Escape')
    close()
}

function close() {
  if (buildTimer) {
    clearTimeout(buildTimer)
    buildTimer = null
  }
  emit('close')
}

function initDeck() {
  const slides = getSlides()
  slides.forEach((s, i) => {
    s.classList.toggle('show', i === 0)
    gsap.set(s, { autoAlpha: i === 0 ? 1 : 0, xPercent: 0, zIndex: i === 0 ? 2 : 1 })
  })
  cur.value = 0
  clearLaunch()
  enter(0)
  // record the first slide impression (navigation only fires for slides 2+)
  track('builder_promo_slide_viewed', { slide: 1 })
}

watch(() => props.open, async (open) => {
  if (open) {
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    track('builder_promo_opened')
    await nextTick()
    initDeck()
  }
  else {
    document.body.style.overflow = ''
    window.removeEventListener('keydown', onKey)
  }
})

onUnmounted(() => {
  if (buildTimer)
    clearTimeout(buildTimer)
  document.body.style.overflow = ''
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Transition name="bp-fade">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4 bp-overlay" role="dialog" aria-modal="true" @click.self="close">
      <div class="bp-modal">
        <!-- top bar -->
        <div class="bp-top">
          <div class="bp-dots">
            <span v-for="i in SLIDE_COUNT" :key="i" class="bp-dot" :class="{ on: cur === i - 1 }" />
          </div>
          <button type="button" class="bp-x" :aria-label="t('builder-promo-close')" @click="close">
            ✕
          </button>
        </div>

        <!-- deck -->
        <div ref="deckEl" class="bp-deck" :class="{ launch: launched }">
          <!-- SLIDE 1 -->
          <div class="bp-slide show">
            <div class="bp-grid bp-grid--term">
              <div class="bp-left bp-left--term">
                <div class="bp-terminal">
                  <div class="bp-term-bar">
                    <span class="bp-td r" /><span class="bp-td y" /><span class="bp-td g" />
                    <span class="bp-term-title">capgo build request --platform {{ termPlatform }}</span>
                    <span class="bp-term-tabs">
                      <button type="button" class="bp-term-tab" :class="{ active: termPlatform === 'ios' }" @click="startTerminal('ios')">iOS</button>
                      <button type="button" class="bp-term-tab" :class="{ active: termPlatform === 'android' }" @click="startTerminal('android')">Android</button>
                    </span>
                  </div>
                  <div class="bp-term-body" />
                </div>
              </div>
              <div class="bp-right">
                <h2>{{ t('builder-promo-s1-title') }}</h2>
                <p class="bp-lead">
                  {{ t('builder-promo-s1-sub') }}
                </p>
                <span class="bp-chip">{{ t('builder-promo-s1-chip') }}</span>
              </div>
            </div>
          </div>

          <!-- SLIDE 2 -->
          <div class="bp-slide">
            <div class="bp-grid">
              <div class="bp-left">
                <div class="bp-texture" />
                <svg class="bp-check" width="150" height="150" viewBox="0 0 120 120">
                  <circle class="bp-s2-ring" cx="60" cy="60" r="52" />
                  <path class="bp-s2-tick" d="M38,62 L54,78 L84,44" />
                </svg>
                <div class="bp-leftcap">
                  {{ t('builder-promo-s2-cap') }}
                </div>
              </div>
              <div class="bp-right">
                <h2>{{ t('builder-promo-s2-title') }}</h2>
                <p class="bp-lead">
                  {{ t('builder-promo-s2-lead') }}
                </p>
                <div class="bp-list">
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s2-item1') }}
                  </div>
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s2-item2') }}
                  </div>
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s2-item3') }}
                  </div>
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s2-item4') }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SLIDE 3 -->
          <div class="bp-slide">
            <div class="bp-grid">
              <div class="bp-left">
                <div class="bp-texture" />
                <div class="bp-duo">
                  <div class="bp-phone back">
                    <div class="bp-punch" />
                    <div class="bp-screen">
                      <div class="bp-sbar">
                        <span>12:30</span><span class="bp-ic"><i /><i /><i /><span class="bp-bat" /></span>
                      </div>
                      <div class="bp-hero">
                        <div class="bp-av" /><div class="bp-h1" /><div class="bp-h2" />
                      </div>
                      <div class="bp-cards">
                        <div class="bp-row">
                          <div class="bp-th" /><div><div class="bp-l1" /><div class="bp-l2" /></div>
                        </div>
                        <div class="bp-row">
                          <div class="bp-th" /><div><div class="bp-l1" /><div class="bp-l2" /></div>
                        </div>
                      </div>
                      <div class="bp-nav" />
                    </div>
                  </div>
                  <div class="bp-phone front">
                    <div class="bp-island" />
                    <div class="bp-screen">
                      <div class="bp-sbar">
                        <span>9:41</span><span class="bp-ic"><i /><i /><i /><span class="bp-bat" /></span>
                      </div>
                      <div class="bp-hero">
                        <div class="bp-av" /><div class="bp-h1" /><div class="bp-h2" />
                      </div>
                      <div class="bp-cards">
                        <div class="bp-row">
                          <div class="bp-th" /><div><div class="bp-l1" /><div class="bp-l2" /></div>
                        </div>
                        <div class="bp-row">
                          <div class="bp-th" /><div><div class="bp-l1" /><div class="bp-l2" /></div>
                        </div>
                      </div>
                      <div class="bp-tabs">
                        <span class="bp-tb act" /><span class="bp-tb" /><span class="bp-tb" /><span class="bp-tb" />
                      </div>
                      <div class="bp-home" />
                    </div>
                  </div>
                </div>
                <div class="bp-pills">
                  <span class="bp-pill">
                    <svg viewBox="0 0 24 24" fill="#fff"><path d="M16.37 1.43c0 1.07-.39 2.06-1.05 2.8-.74.82-1.95 1.45-2.99 1.36-.13-1.03.39-2.13 1.03-2.83.73-.8 2-1.4 3.01-1.33ZM20.3 17.05c-.52 1.2-.77 1.73-1.44 2.78-.93 1.47-2.25 3.29-3.88 3.3-1.45.01-1.82-.94-3.78-.93-1.96.01-2.37.94-3.82.92-1.63-.01-2.88-1.65-3.8-3.12-2.6-4.1-2.87-8.9-1.27-11.45 1-1.44 2.58-2.29 4.06-2.29 1.51 0 2.46.94 3.71.94 1.21 0 1.95-.94 3.7-.94 1.32 0 2.71.72 3.71 1.96-3.26 1.78-2.73 6.42.81 7.8Z" /></svg> iOS
                  </span>
                  <span class="bp-pill">
                    <svg viewBox="0 0 24 24" fill="#3ddc84"><path d="M5.5 9h13v7.5a1.2 1.2 0 0 1-1.2 1.2H16v2.6a1.1 1.1 0 0 1-2.2 0V17.7h-3.6v2.6a1.1 1.1 0 0 1-2.2 0V17.7H6.7A1.2 1.2 0 0 1 5.5 16.5V9Z" /><rect x="2.4" y="9" width="2.2" height="6.4" rx="1.1" /><rect x="19.4" y="9" width="2.2" height="6.4" rx="1.1" /><path d="M6.6 8a5.4 5.4 0 0 1 10.8 0H6.6Z" /><circle cx="9.5" cy="5.4" r=".75" fill="#0b1424" /><circle cx="14.5" cy="5.4" r=".75" fill="#0b1424" /></svg> Android
                  </span>
                </div>
                <div class="bp-cap">
                  {{ t('builder-promo-s3-cap1') }} <b>{{ t('builder-promo-s3-cap2') }}</b>
                </div>
              </div>
              <div class="bp-right">
                <h2>{{ t('builder-promo-s3-title') }}</h2>
                <p class="bp-lead">
                  {{ t('builder-promo-s3-lead') }}
                </p>
                <div class="bp-list">
                  <div class="bp-item">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s3-item1') }}
                  </div>
                  <div class="bp-item">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s3-item2') }}
                  </div>
                  <div class="bp-item">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s3-item3') }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SLIDE 4 -->
          <div class="bp-slide">
            <div class="bp-grid">
              <div class="bp-left">
                <div class="bp-texture" />
                <svg width="0" height="0" style="position:absolute"><defs><linearGradient id="bpShieldGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#119eff" /><stop offset="1" stop-color="#0b3a63" /></linearGradient></defs></svg>
                <div class="bp-shieldwrap">
                  <div class="bp-shield-pulse" />
                  <svg class="bp-shield-ring" viewBox="0 0 158 158"><circle cx="79" cy="79" r="74" /></svg>
                  <svg class="bp-shield" width="110" height="116" viewBox="0 0 64 68"><path class="bp-shield-body" d="M32 4 L57 14 L57 33 C57 49 46 60 32 64 C18 60 7 49 7 33 L7 14 Z" /><path class="bp-shield-tk" d="M23 33 L29 40 L42 25" /></svg>
                </div>
                <div class="bp-leftcap">
                  {{ t('builder-promo-s4-cap') }}
                </div>
              </div>
              <div class="bp-right">
                <h2>{{ t('builder-promo-s4-title') }}</h2>
                <p class="bp-lead">
                  {{ t('builder-promo-s4-lead') }}
                </p>
                <div class="bp-list">
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s4-item1') }}
                  </div>
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s4-item2') }}
                  </div>
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s4-item3') }}
                  </div>
                  <div class="bp-item g">
                    <span class="bp-c">✓</span> {{ t('builder-promo-s4-item4') }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SLIDE 5 -->
          <div class="bp-slide">
            <div class="bp-grid">
              <div class="bp-left">
                <div class="bp-texture" />
                <div class="bp-pad">
                  <div class="bp-rk-glow" />
                  <div class="bp-rk-blast" />
                  <div class="bp-rocketbob">
                    <div class="bp-exhaust">
                      <div class="bp-smoke">
                        <span class="bp-puff" /><span class="bp-puff" /><span class="bp-puff" /><span class="bp-puff" />
                      </div>
                      <div class="bp-flame" />
                    </div>
                    <svg class="bp-rocket" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
                      <polygon style="fill:#CA2C31;" points="3.77,71.73 20.11,55.63 47.93,50.7 45.18,65.26 7.57,76.82 5.14,75.77 " />
                      <polygon style="fill:#A02422;" points="22.94,59.76 5.2,75.88 18.25,82.24 38.06,72.13 38.06,67.36 42.11,56.44 " />
                      <path style="fill:#A02422;" d="M64.92,88.15l-8.57,3.72l-8.09,17.15c0,0,7.12,15.77,7.44,15.77c0.32,0,4.37,0.32,4.37,0.32l14.4-16.1l3.64-27.5L64.92,88.15z" />
                      <path style="fill:#CA2C31;" d="M56.5,100.84c0,0,4.77-0.97,8.17-2.59c3.4-1.62,7.6-4.04,7.6-4.04l-1.54,13.43l-15.05,17.13c0,0-0.59-0.73-3.09-6.17c-1.99-4.34-2.68-5.89-2.68-5.89L56.5,100.84z" />
                      <path style="fill:#858585;" d="M36.35,74.44c0,0-3.11,2.77-4.22,4.36c-1.11,1.59-1.11,1.73-1.04,2.21c0.07,0.48,1.22,5.75,6.01,10.37c5.88,5.67,11.13,6.43,11.89,6.43c0.76,0,5.81-5.67,5.81-5.67L36.35,74.44z" />
                      <path style="fill:#437687;" d="M50.1,91.24c0,0,5.04,3.31,13.49,0.47c11.55-3.88,20.02-12.56,30.51-23.52c10.12-10.58,18.61-23.71,18.61-23.71l-5.95-19.93L50.1,91.24z" />
                      <path style="fill:#3F545F;" d="M67.99,80.33l1.39-4.32l3.48,0.49c0,0,2.65,1.25,4.6,2.16c1.95,0.91,4.46,1.6,4.46,1.6l-4.95,4.18c0,0-2.7-1.02-4.67-1.88C70.08,81.59,67.99,80.33,67.99,80.33z" />
                      <path style="fill:#8DAFBF;" d="M84.32,16.14c0,0-9.62,5.58-23.41,18.63c-12.43,11.76-21.64,22.4-23.87,31.45c-1.86,7.58-0.87,12.18,3.36,17.15c4.47,5.26,9.71,7.87,9.71,7.87s3.94,0.06,20.38-12.59c20.51-15.79,36.94-42.23,36.94-42.23L84.32,16.14z" />
                      <path style="fill:#D83F22;" d="M104.18,41.84c0,0-8.37-3.57-14.34-11.9c-5.93-8.27-5.46-13.86-5.46-13.86s4.96-3.89,16.11-8.34c7.5-2.99,17.71-4.52,21.07-2.03s-2.3,14.98-2.3,14.98l-10.31,19.96L104.18,41.84z" />
                      <path style="fill:#6896A5;" d="M68.17,80.4c0,0-7.23-3.69-11.83-8.94c-8.7-9.91-10.5-20.79-10.5-20.79l4.37-5.13c0,0,1.09,11.56,10.42,21.55c6.08,6.51,12.43,9.49,12.43,9.49s-1.27,1.07-2.63,2.11C69.56,79.36,68.17,80.4,68.17,80.4z" />
                      <path style="fill:#A02422;" d="M112.71,44.48c0,0,4.34-5.23,8.45-17.02c5.74-16.44,0.74-21.42,0.74-21.42s-1.69,7.82-7.56,18.69c-4.71,8.71-10.41,17-10.41,17s3.14,1.41,4.84,1.9C110.91,44.25,112.71,44.48,112.71,44.48z" />
                      <path style="fill:#B3E1EE;" d="M39.81,69.66c1.3,1.24,3.27-0.06,4.56-3.1c1.3-3.04,1.28-4.74,0.28-5.46c-1.24-0.9-3.32,1.07-4.23,2.82C39.42,65.86,38.83,68.72,39.81,69.66z" />
                      <path style="fill:#B3E1EE;" d="M84.95,20.13c0,0-7.61,5.47-15.73,12.91c-7.45,6.83-12.39,12.17-13.07,13.41c-0.72,1.33-0.73,3.21-0.17,4.17s1.8,1.46,2.93,0.62c1.13-0.85,9.18-9.75,16.45-16.11c6.65-5.82,11.78-9.51,11.78-9.51s2.08-3.68,1.74-4.52C88.54,20.25,84.95,20.13,84.95,20.13z" />
                      <path style="fill:#ED6A65;" d="M84.95,20.13c0,0,5.62-4.31,11.74-7.34c5.69-2.82,11.35-5.17,12.37-3.13c0.97,1.94-5.37,4.58-10.95,8.14c-5.58,3.56-10.95,7.81-10.95,7.81s-0.82-1.5-1.35-2.89C85.22,21.21,84.95,20.13,84.95,20.13z" />
                      <path style="fill:#E1E1E1;" d="M89.59,39.25c-5.57-5.13-13.32-3.75-17.14,0.81c-3.92,4.7-3.63,11.88,1,16.2c4.21,3.92,12.04,4.81,16.76-0.69C94.41,50.69,94.15,43.44,89.59,39.25z" />
                      <path style="fill:#3F545F;" d="M75.33,41.87c-3.31,3.25-3.13,9.69,0.81,12.63c3.44,2.57,8.32,2.44,11.38-0.69c3.06-3.13,3.06-8.82,0.19-11.76C84.41,38.68,79.12,38.15,75.33,41.87z" />
                      <path style="fill:#A02524;" d="M50,76.89c0,0,6.19-6.28,6.87-5.6c0.68,0.68,0.59,4.49-2.37,8.73c-2.97,4.24-9.5,11.79-14.67,16.88c-5.1,5.01-12.29,10.74-12.97,10.64c-0.53-0.08-2.68-1.15-3.54-2.19c-0.84-1.03,1.67-5.9,2.68-7.51C27.02,96.23,50,76.89,50,76.89z" />
                      <path style="fill:#CA2C31;" d="M21.23,101.85c-0.08,1.44,2.12,3.54,2.12,3.54L56.87,71.3c0,0-1.57-1.77-6.19,1.1c-4.66,2.9-8.74,6.38-14.76,12.21C27.53,92.75,21.31,100.41,21.23,101.85z" />
                    </svg>
                  </div>
                </div>
              </div>
              <div class="bp-right">
                <h2>{{ t('builder-promo-s5-title') }}</h2>
                <p class="bp-lead">
                  {{ t('builder-promo-s5-lead1') }} <b>{{ t('builder-promo-s5-lead2') }}</b>
                </p>
                <div>
                  <button type="button" class="bp-cta" @click="startBuild">
                    {{ t('builder-promo-s5-cta') }}
                    <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- footer -->
        <div class="bp-foot">
          <button type="button" class="bp-ghost" :disabled="isFirst" @click="prev">
            ← {{ t('builder-promo-back') }}
          </button>
          <button type="button" v-if="!isLast" class="bp-next" @click="next">
            {{ t('builder-promo-next') }} →
          </button>
          <span v-else />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.bp-fade-enter-active,
.bp-fade-leave-active {
  transition: opacity 0.25s ease;
}
.bp-fade-enter-from,
.bp-fade-leave-to {
  opacity: 0;
}

.bp-overlay {
  background: rgba(2, 8, 18, 0.72);
  backdrop-filter: blur(3px);
}
.bp-modal {
  /* theme tokens — light mode is the default; .dark overrides below */
  --bp-surface: #ffffff;
  --bp-border: #e3e8f0;
  --bp-heading: #0f172a;
  --bp-text: #334155;
  --bp-muted: #5b6b82;
  --bp-dot: #cbd5e1;
  --bp-x: #94a3b8;
  --bp-ghost-border: #cbd5e1;
  --bp-ghost-text: #475569;
  --bp-chip-bg: rgba(17, 158, 255, 0.1);
  --bp-chip-border: rgba(17, 158, 255, 0.38);
  --bp-chip-text: #0c87e0;
  --bp-c-bg: rgba(17, 158, 255, 0.1);
  --bp-c-border: rgba(17, 158, 255, 0.4);
  --bp-c-text: #0c87e0;
  --bp-cg-bg: rgba(16, 185, 129, 0.13);
  --bp-cg-border: rgba(16, 185, 129, 0.42);
  --bp-cg-text: #059669;
  --bp-modal-shadow: 0 30px 80px rgba(15, 23, 42, 0.26);
  /* left "stage" panel */
  --bp-stage: radial-gradient(120% 120% at 35% 25%, #eef5ff 0%, #e3eefb 55%, #dbe8f8 100%);
  --bp-stage-text: #1e293b;
  --bp-stage-shadow: none;
  --bp-stage-accent: #0c87e0;
  --bp-texture-dot: rgba(15, 23, 42, 0.06);
  --bp-pill-bg: rgba(255, 255, 255, 0.78);
  --bp-pill-border: rgba(15, 23, 42, 0.1);
  --bp-pill-text: #1e293b;
  --bp-tick: #0b7a4f;
  /* terminal (light theme) */
  --bp-term-bg: #ffffff;
  --bp-term-bar-bg: #f1f4f9;
  --bp-term-border: rgba(15, 23, 42, 0.1);
  --bp-term-bar-border: rgba(15, 23, 42, 0.07);
  --bp-term-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
  --bp-term-fg: #41506a;
  --bp-term-title: #64748b;
  --bp-term-tab-fg: #64748b;
  --bp-term-tab-border: rgba(15, 23, 42, 0.12);
  --bp-term-tab-active-bg: rgba(22, 163, 74, 0.12);
  --bp-term-tab-active-fg: #16a34a;
  --bp-term-tab-active-border: rgba(22, 163, 74, 0.4);
  --bp-t-dim: #94a3b8;
  --bp-t-cmd: #1f2d3d;
  --bp-t-flag: #475569;
  --bp-t-val: #16a34a;
  --bp-t-kw: #2563eb;
  --bp-t-ok: #16a34a;
  --bp-t-lock: #ca8a04;
  --bp-t-prompt: #94a3b8;
  --bp-t-cursor: #334155;
  --bp-qr-shadow: 0 0 0 1px rgba(15, 23, 42, 0.1), 0 6px 16px rgba(15, 23, 42, 0.16);
  /* slide 5 rocket */
  --bp-rk-glow: transparent;
  --bp-flame-grad: radial-gradient(
    ellipse 60% 42% at 50% 12%,
    #fff1b0 0%,
    #ffce33 30%,
    #ffaa28 58%,
    #ff8d1e 82%,
    rgba(255, 141, 30, 0) 100%
  );
  --bp-flame-glow: drop-shadow(0 1px 8px rgba(255, 158, 46, 0.6));

  width: 900px;
  max-width: 100%;
  background: var(--bp-surface);
  border: 1px solid var(--bp-border);
  border-radius: 20px;
  box-shadow: var(--bp-modal-shadow);
  overflow: hidden;
}
.dark .bp-modal {
  --bp-surface: #0b1424;
  --bp-border: #16233a;
  --bp-heading: #ffffff;
  --bp-text: #e2e8f0;
  --bp-muted: #94a3b8;
  --bp-dot: #334155;
  --bp-x: #475569;
  --bp-ghost-border: #1e293b;
  --bp-ghost-text: #94a3b8;
  --bp-chip-bg: rgba(17, 158, 255, 0.16);
  --bp-chip-border: rgba(17, 158, 255, 0.5);
  --bp-chip-text: #7dd3fc;
  --bp-c-bg: rgba(17, 158, 255, 0.16);
  --bp-c-border: rgba(17, 158, 255, 0.5);
  --bp-c-text: #7dd3fc;
  --bp-cg-bg: rgba(30, 215, 166, 0.16);
  --bp-cg-border: rgba(30, 215, 166, 0.5);
  --bp-cg-text: #34d399;
  --bp-modal-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  --bp-stage: radial-gradient(120% 120% at 35% 25%, #1f6fb2 0%, #0b3a63 55%, #062744 100%);
  --bp-stage-text: #ffffff;
  --bp-stage-shadow: 0 2px 16px rgba(0, 0, 0, 0.4);
  --bp-stage-accent: #7dd3fc;
  --bp-texture-dot: rgba(255, 255, 255, 0.07);
  --bp-pill-bg: rgba(8, 18, 31, 0.55);
  --bp-pill-border: rgba(255, 255, 255, 0.16);
  --bp-pill-text: #eaf4ff;
  --bp-tick: #eafff5;
  --bp-term-bg: #0a0d14;
  --bp-term-bar-bg: linear-gradient(#0e1320, #0a0d14);
  --bp-term-border: rgba(255, 255, 255, 0.09);
  --bp-term-bar-border: rgba(255, 255, 255, 0.06);
  --bp-term-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  --bp-term-fg: #c8d4e6;
  --bp-term-title: #6b7a91;
  --bp-term-tab-fg: rgba(255, 255, 255, 0.55);
  --bp-term-tab-border: rgba(255, 255, 255, 0.1);
  --bp-term-tab-active-bg: rgba(74, 222, 128, 0.12);
  --bp-term-tab-active-fg: #4ade80;
  --bp-term-tab-active-border: rgba(74, 222, 128, 0.4);
  --bp-t-dim: #5a6a82;
  --bp-t-cmd: #93a4bd;
  --bp-t-flag: #93a4bd;
  --bp-t-val: #4ade80;
  --bp-t-kw: #60a5fa;
  --bp-t-ok: #4ade80;
  --bp-t-lock: #facc15;
  --bp-t-prompt: #5a6a82;
  --bp-t-cursor: #c8d4e6;
  --bp-qr-shadow: 0 0 0 1px rgba(255, 255, 255, 0.15), 0 6px 16px rgba(0, 0, 0, 0.4);
  --bp-rk-glow: rgba(17, 158, 255, 0.45);
  --bp-flame-grad: radial-gradient(
    ellipse 60% 42% at 50% 12%,
    #ffffff 0%,
    #ffe79e 20%,
    #ffb02e 45%,
    #ff6a2b 70%,
    rgba(255, 74, 28, 0) 100%
  );
  --bp-flame-glow: drop-shadow(0 0 11px rgba(255, 140, 40, 0.9));
}
.bp-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--bp-border);
}
.bp-dots {
  display: flex;
  gap: 7px;
}
.bp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bp-dot);
  transition: all 0.3s;
}
.bp-dot.on {
  background: #119eff;
  width: 22px;
  border-radius: 5px;
}
.bp-x {
  color: var(--bp-x);
  font-size: 20px;
  line-height: 1;
  background: none;
  border: 0;
  cursor: pointer;
}

.bp-deck {
  position: relative;
  height: 450px;
  overflow: hidden;
}
@media (max-width: 640px) {
  .bp-deck {
    height: 560px;
  }
}
.bp-slide {
  position: absolute;
  inset: 0;
  opacity: 0;
}
.bp-slide.show {
  opacity: 1;
  z-index: 2;
}

.bp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-top: 1px solid var(--bp-border);
}
.bp-ghost {
  background: transparent;
  border: 1px solid var(--bp-ghost-border);
  color: var(--bp-ghost-text);
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 9px;
  cursor: pointer;
}
.bp-ghost:disabled {
  opacity: 0.35;
  cursor: default;
}
.bp-next {
  background: #119eff;
  border: 0;
  color: #04121f;
  font-weight: 700;
  font-size: 13px;
  padding: 9px 18px;
  border-radius: 9px;
  cursor: pointer;
}

/* shared slide layout */
.bp-grid {
  display: grid;
  grid-template-columns: 0.95fr 1.05fr;
  height: 100%;
}
@media (max-width: 640px) {
  .bp-grid {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
}
.bp-left {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: var(--bp-stage);
}
.bp-left.sec {
  background:
    radial-gradient(60% 50% at 50% 30%, rgba(30, 215, 166, 0.16), transparent 70%),
    radial-gradient(130% 120% at 40% 24%, #143a63 0%, #0b2a49 52%, #06182c 100%);
}
.bp-texture {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--bp-texture-dot) 1px, transparent 1.4px);
  background-size: 18px 18px;
  mask: radial-gradient(70% 60% at 45% 38%, #000 30%, transparent 75%);
  opacity: 0.4;
}
.bp-right {
  padding: 32px 34px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--bp-surface);
}
.bp-right h2 {
  font-size: 23px;
  line-height: 1.16;
  font-weight: 800;
  color: var(--bp-heading);
  margin: 0 0 10px;
}
.bp-lead {
  color: var(--bp-muted);
  font-size: 14.5px;
  line-height: 1.55;
  margin: 0 0 18px;
}
.bp-lead b {
  color: var(--bp-heading);
}
.bp-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.bp-item {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 14.5px;
  color: var(--bp-text);
}
.bp-c {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  background: var(--bp-c-bg);
  border: 1px solid var(--bp-c-border);
  color: var(--bp-c-text);
  font-size: 12px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bp-item.g .bp-c {
  background: var(--bp-cg-bg);
  border-color: var(--bp-cg-border);
  color: var(--bp-cg-text);
}
.bp-leftcap {
  z-index: 1;
  color: var(--bp-stage-text);
  font-size: 18px;
  font-weight: 800;
  text-shadow: var(--bp-stage-shadow);
  text-align: center;
}
.bp-chip {
  z-index: 1;
  align-self: flex-start;
  background: var(--bp-chip-bg);
  border: 1px solid var(--bp-chip-border);
  color: var(--bp-chip-text);
  font-size: 12px;
  font-weight: 700;
  padding: 6px 13px;
  border-radius: 999px;
  margin-top: 16px;
}

/* slide 1 — terminal hook (same column split as every other slide for a consistent left panel) */
.bp-grid--term {
  grid-template-columns: 0.95fr 1.05fr;
}
.bp-left--term {
  padding: 20px;
  gap: 0;
}
.bp-terminal {
  width: 100%;
  z-index: 1;
  background: var(--bp-term-bg);
  border: 1px solid var(--bp-term-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--bp-term-shadow);
}
.bp-term-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  background: var(--bp-term-bar-bg);
  border-bottom: 1px solid var(--bp-term-bar-border);
}
.bp-td {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}
.bp-td.r {
  background: #ef4444;
}
.bp-td.y {
  background: #f59e0b;
}
.bp-td.g {
  background: #22c55e;
}
.bp-term-title {
  margin-left: 8px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: var(--bp-term-title);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-term-tabs {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
  flex: none;
}
.bp-term-tab {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--bp-term-tab-fg);
  background: transparent;
  border: 1px solid var(--bp-term-tab-border);
  border-radius: 6px;
  padding: 3px 9px;
  cursor: pointer;
}
.bp-term-tab.active {
  background: var(--bp-term-tab-active-bg);
  color: var(--bp-term-tab-active-fg);
  border-color: var(--bp-term-tab-active-border);
}
.bp-term-body {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 14px 16px;
  height: 336px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bp-term-fg);
}
.bp-term-body :deep(.dim) {
  color: var(--bp-t-dim);
}
.bp-term-body :deep(.cmd) {
  color: var(--bp-t-cmd);
}
.bp-term-body :deep(.flag) {
  color: var(--bp-t-flag);
}
.bp-term-body :deep(.val) {
  color: var(--bp-t-val);
}
.bp-term-body :deep(.kw) {
  color: var(--bp-t-kw);
}
.bp-term-body :deep(.ok) {
  color: var(--bp-t-ok);
}
.bp-term-body :deep(.lock) {
  color: var(--bp-t-lock);
}
.bp-term-body :deep(.ghost) {
  opacity: 0.55;
}
.bp-term-body :deep(.prompt) {
  color: var(--bp-t-prompt);
}
.bp-term-body :deep(.bp-cursor) {
  display: inline-block;
  width: 7px;
  height: 1em;
  background: var(--bp-t-cursor);
  vertical-align: -2px;
  animation: bp-blink 1s steps(1) infinite;
}
@keyframes bp-blink {
  50% {
    opacity: 0;
  }
}
.bp-term-body :deep(.bp-qr-line) {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.bp-term-body :deep(.bp-qr) {
  width: 66px;
  height: 66px;
  border-radius: 8px;
  background: #fff;
  padding: 4px;
  box-shadow: var(--bp-qr-shadow);
}
.bp-term-body :deep(.bp-qr-meta) {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
}
.bp-term-body :deep(.bp-qr-meta .kw) {
  font-weight: 700;
}

/* slide 2 */
.bp-check {
  filter: drop-shadow(0 0 22px rgba(52, 211, 153, 0.45));
}
.bp-s2-ring {
  fill: none;
  stroke: #34d399;
  stroke-width: 7;
  stroke-linecap: round;
  stroke-dasharray: 327;
  stroke-dashoffset: 327;
}
.bp-s2-tick {
  fill: none;
  stroke: var(--bp-tick);
  stroke-width: 9;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 70;
  stroke-dashoffset: 70;
}

/* slide 3 phones */
.bp-duo {
  position: relative;
  width: 240px;
  height: 236px;
  z-index: 1;
}
.bp-phone {
  position: absolute;
  width: 118px;
  height: 230px;
  border-radius: 25px;
  background: linear-gradient(160deg, #10243c, #0a1626);
  padding: 5px;
  box-shadow:
    inset 0 0 0 1.5px rgba(255, 255, 255, 0.13),
    inset 0 0 0 5px #0a1828,
    0 22px 40px rgba(0, 0, 0, 0.55);
}
.bp-screen {
  position: relative;
  height: 100%;
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(170deg, #0e2c4c, #0a1a2e 60%, #091627);
  display: flex;
  flex-direction: column;
}
.bp-phone.back {
  left: 106px;
  top: 18px;
  transform: rotate(7deg) scale(0.93);
  animation: bp-fb 5.5s ease-in-out infinite;
}
.bp-phone.front {
  left: 14px;
  top: 2px;
  z-index: 2;
  animation: bp-ff 5s ease-in-out infinite;
}
@keyframes bp-ff {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-8px);
  }
}
@keyframes bp-fb {
  0%,
  100% {
    transform: rotate(7deg) scale(0.93) translateY(0);
  }
  50% {
    transform: rotate(7deg) scale(0.93) translateY(-6px);
  }
}
.bp-island {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  width: 25px;
  height: 10px;
  border-radius: 6px;
  background: #05101d;
  z-index: 5;
}
.bp-punch {
  position: absolute;
  top: 13px;
  left: 50%;
  transform: translateX(-50%);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #05101d;
  z-index: 5;
}
.bp-sbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 26px;
  padding: 0 13px;
  font-size: 8.5px;
  color: #dbeeff;
  font-weight: 700;
}
.bp-ic {
  display: flex;
  gap: 1.6px;
  align-items: flex-end;
}
.bp-ic i {
  display: block;
  width: 2.1px;
  border-radius: 1px;
  background: #dbeeff;
  opacity: 0.9;
}
.bp-ic i:nth-child(1) {
  height: 3px;
}
.bp-ic i:nth-child(2) {
  height: 5px;
}
.bp-ic i:nth-child(3) {
  height: 7px;
}
.bp-bat {
  width: 11px;
  height: 6px;
  border: 1px solid #dbeeff;
  border-radius: 2px;
  position: relative;
  opacity: 0.9;
  margin-left: 3px;
}
.bp-bat::after {
  content: '';
  position: absolute;
  inset: 1px;
  right: 3px;
  background: #3ddc84;
  border-radius: 1px;
}
.bp-hero {
  margin: 5px 9px 0;
  border-radius: 12px;
  padding: 9px;
  background: linear-gradient(135deg, #119eff, #1ed7a6);
}
.bp-av {
  width: 23px;
  height: 23px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.95);
  margin-bottom: 7px;
}
.bp-h1 {
  height: 5px;
  width: 62%;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 3px;
  margin-bottom: 4px;
}
.bp-h2 {
  height: 4px;
  width: 42%;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 3px;
}
.bp-cards {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.bp-row {
  display: flex;
  gap: 8px;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 9px;
  padding: 6px;
}
.bp-th {
  width: 21px;
  height: 21px;
  border-radius: 6px;
  flex: none;
}
.bp-row:nth-child(1) .bp-th {
  background: linear-gradient(135deg, #119eff, #38bdf8);
}
.bp-row:nth-child(2) .bp-th {
  background: linear-gradient(135deg, #1ed7a6, #119eff);
}
.bp-l1 {
  height: 4px;
  width: 70%;
  background: rgba(255, 255, 255, 0.55);
  border-radius: 3px;
  margin-bottom: 3px;
}
.bp-l2 {
  height: 3px;
  width: 45%;
  background: rgba(255, 255, 255, 0.28);
  border-radius: 3px;
}
.bp-tabs {
  display: flex;
  justify-content: space-around;
  align-items: center;
  padding: 7px 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.bp-tb {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.18);
}
.bp-tb.act {
  background: #119eff;
}
.bp-home {
  width: 38px;
  height: 3.5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.55);
  margin: 5px auto 7px;
}
.bp-nav {
  width: 38px;
  height: 3.5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.4);
  margin: 5px auto 7px;
}
.bp-pills {
  display: flex;
  gap: 10px;
  z-index: 1;
}
.bp-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--bp-pill-bg);
  border: 1px solid var(--bp-pill-border);
  color: var(--bp-pill-text);
  font-size: 12px;
  font-weight: 700;
}
.bp-pill svg {
  width: 13px;
  height: 13px;
  display: block;
}
.bp-cap {
  z-index: 1;
  color: var(--bp-stage-text);
  font-size: 17px;
  font-weight: 800;
}
.bp-cap b {
  color: var(--bp-stage-accent);
}

/* slide 4 shield */
.bp-shieldwrap {
  position: relative;
  width: 158px;
  height: 158px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
}
.bp-shield-pulse {
  position: absolute;
  width: 116px;
  height: 116px;
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(17, 158, 255, 0.4), transparent 70%);
  animation: bp-shp 4s ease-in-out infinite;
}
@keyframes bp-shp {
  0%,
  100% {
    opacity: 0.5;
    transform: scale(1);
  }
  50% {
    opacity: 0.85;
    transform: scale(1.08);
  }
}
.bp-shield-ring {
  position: absolute;
  inset: 0;
  animation: bp-spin 14s linear infinite;
}
.bp-shield-ring circle {
  fill: none;
  stroke: rgba(125, 211, 252, 0.5);
  stroke-width: 2;
  stroke-dasharray: 4 9;
}
@keyframes bp-spin {
  to {
    transform: rotate(360deg);
  }
}
.bp-shield {
  filter: drop-shadow(0 8px 24px rgba(17, 158, 255, 0.45));
}
.bp-shield-body {
  fill: url(#bpShieldGrad);
  stroke: #7dd3fc;
  stroke-width: 2.5;
}
.bp-shield-tk {
  fill: none;
  stroke: #eafff5;
  stroke-width: 5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* slide 5 rocket */
.bp-pad {
  position: relative;
  z-index: 1;
  width: 220px;
  height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bp-rk-glow {
  position: absolute;
  left: 42%;
  top: 60%;
  width: 150px;
  height: 84px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--bp-rk-glow), transparent 72%);
  filter: blur(7px);
  animation: bp-shp 4s ease-in-out infinite;
}
.bp-rocketbob {
  position: relative;
  z-index: 4;
  width: 148px;
  height: 148px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: bp-rkbob 3.4s ease-in-out infinite;
}
@keyframes bp-rkbob {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(3px, -7px);
  }
}
.bp-rocket {
  position: relative;
  z-index: 5;
  width: 140px;
  height: 140px;
  display: block;
  filter: drop-shadow(0 10px 16px rgba(0, 0, 0, 0.45));
}
.bp-exhaust {
  position: absolute;
  left: 54px;
  top: 89px;
  transform-origin: top center;
  transform: rotate(34deg);
  z-index: 2;
  pointer-events: none;
  transition: transform 0.2s ease;
}
.bp-flame {
  width: 31px;
  height: 80px;
  margin-left: -15.5px;
  background: var(--bp-flame-grad);
  border-radius: 50% 50% 48% 48% / 28% 28% 82% 82%;
  filter: blur(0.4px) var(--bp-flame-glow);
  transform-origin: 50% 0%;
  animation: bp-flick 0.12s ease-in-out infinite alternate;
}
@keyframes bp-flick {
  from {
    transform: scaleY(0.9) scaleX(1);
  }
  to {
    transform: scaleY(1.12) scaleX(0.9);
  }
}
.bp-smoke {
  position: absolute;
  left: 0;
  top: 6px;
  width: 8px;
  height: 8px;
}
.bp-puff {
  position: absolute;
  left: 50%;
  top: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(226, 228, 233, 0.42);
  filter: blur(4px);
  transform: translate(-50%, 0);
  animation: bp-puff 1.9s ease-out infinite;
}
.bp-puff:nth-child(1) {
  animation-delay: 0s;
  --x: -6px;
}
.bp-puff:nth-child(2) {
  animation-delay: 0.5s;
  --x: 8px;
}
.bp-puff:nth-child(3) {
  animation-delay: 1s;
  --x: -10px;
}
.bp-puff:nth-child(4) {
  animation-delay: 1.4s;
  --x: 6px;
}
@keyframes bp-puff {
  0% {
    opacity: 0;
    transform: translate(-50%, 0) scale(0.4);
  }
  20% {
    opacity: 0.66;
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--x, 0px)), 76px) scale(2.3);
  }
}
.bp-rk-blast {
  position: absolute;
  left: 42%;
  top: 64%;
  transform: translate(-50%, -50%) scale(0);
  width: 124px;
  height: 72px;
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(226, 228, 233, 0.5), transparent 75%);
  filter: blur(6px);
  opacity: 0;
  z-index: 2;
}
.bp-cta {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  background: linear-gradient(135deg, #1f9dff, #0a63c2);
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  border: 0;
  border-radius: 12px;
  padding: 13px 22px;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(17, 158, 255, 0.4);
}
.bp-cta:active {
  transform: scale(0.97);
}
.bp-cta svg {
  width: 16px;
  height: 16px;
}

/* launch (CSS) */
.bp-deck.launch .bp-rocketbob {
  animation: bp-launch 1.25s cubic-bezier(0.4, 0, 0.85, 0.25) forwards;
}
@keyframes bp-launch {
  0% {
    transform: translate(0, 0);
  }
  16% {
    transform: translate(-9px, 8px);
  }
  100% {
    transform: translate(560px, -600px) scale(0.5);
    opacity: 0;
  }
}
.bp-deck.launch .bp-exhaust {
  transform: rotate(45deg);
}
.bp-deck.launch .bp-flame {
  animation: bp-rkbig 0.55s ease-in forwards;
}
@keyframes bp-rkbig {
  0% {
    transform: scaleY(1) scaleX(1);
  }
  100% {
    transform: scaleY(2.6) scaleX(1.05);
    opacity: 0.97;
  }
}
.bp-deck.launch .bp-rk-blast {
  animation: bp-rkblast 1.3s ease-out forwards;
}
@keyframes bp-rkblast {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.2);
  }
  25% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(2.6);
  }
}

@media (prefers-reduced-motion: reduce) {
  .bp-phone,
  .bp-rocketbob,
  .bp-rk-glow,
  .bp-shield-pulse,
  .bp-shield-ring,
  .bp-flame,
  .bp-arrow,
  .bp-puff {
    animation: none !important;
  }
}
</style>
