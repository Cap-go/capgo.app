<script setup lang="ts">
import { gsap } from 'gsap'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconGithub from '~icons/lucide/github'

const props = defineProps<{ active: boolean, supportTier: 'paying' | 'trial' }>()

const { t } = useI18n()
const rootEl = ref<HTMLElement | null>(null)
const matrixEl = ref<HTMLCanvasElement | null>(null)
const storyComplete = ref(false)
const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const emailAccount = computed(() => t(props.supportTier === 'trial' ? 'priority-support-story-email-trial-body' : 'priority-support-story-email-paying-body'))

let storyContext: gsap.Context | null = null
let storyTimeline: gsap.core.Timeline | null = null
let matrixFrame = 0
let matrixLastFrame = 0
let matrixDrops: number[] = []

function stopMatrix() {
  if (matrixFrame)
    cancelAnimationFrame(matrixFrame)
  matrixFrame = 0
  matrixLastFrame = 0
}

function startMatrix() {
  stopMatrix()
  const canvas = matrixEl.value
  if (!canvas)
    return

  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
  const context = canvas.getContext('2d')
  if (!context)
    return

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  const fontSize = 12
  const columns = Math.ceil(rect.width / fontSize)
  matrixDrops = Array.from({ length: columns }, (_, index) => (index * 7) % Math.max(1, Math.ceil(rect.height / fontSize)))
  const glyphs = '01CAPGO<>[]{}'

  const draw = (time: number) => {
    if (time - matrixLastFrame > 32) {
      matrixLastFrame = time
      context.fillStyle = 'rgba(3, 12, 9, 0.18)'
      context.fillRect(0, 0, rect.width, rect.height)
      context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`
      matrixDrops.forEach((drop, index) => {
        const glyph = glyphs[(index * 13 + drop * 5) % glyphs.length]
        context.fillStyle = index % 7 === 0 ? 'rgba(176, 255, 197, 0.82)' : 'rgba(46, 204, 113, 0.55)'
        context.fillText(glyph, index * fontSize, drop * fontSize)
        matrixDrops[index] = drop * fontSize > rect.height + 24 ? 0 : drop + 1
      })
    }
    matrixFrame = requestAnimationFrame(draw)
  }
  matrixFrame = requestAnimationFrame(draw)
}

function stopStory() {
  stopMatrix()
  storyTimeline?.kill()
  storyTimeline = null
  storyContext?.revert()
  storyContext = null
}

function replayStory() {
  if (!props.active || reduce || !storyTimeline)
    return

  storyComplete.value = false
  stopMatrix()
  storyTimeline.invalidate().restart()
}

function startStory() {
  stopStory()
  storyComplete.value = false
  const root = rootEl.value
  if (!root)
    return

  storyContext = gsap.context(() => {
    const find = <T extends Element>(selector: string) => root.querySelector<T>(selector)
    const userMachine = find<HTMLElement>('.pss-user-machine')
    const supportMachine = find<HTMLElement>('.pss-support-machine')
    const pointer = find<HTMLElement>('.pss-pointer')
    const pointerRing = find<HTMLElement>('.pss-pointer-ring')
    const userBrowser = find<HTMLElement>('.pss-user-browser')
    const userBrowserIcon = find<HTMLElement>('.pss-user-browser-icon')
    const userAddress = find<HTMLElement>('.pss-user-address')
    const userIssuesCount = find<HTMLElement>('.pss-user-issues-count')
    const titleInput = find<HTMLElement>('.pss-title-input')
    const titleCopy = find<HTMLElement>('.pss-title-copy')
    const titleCaret = find<HTMLElement>('.pss-title-caret')
    const bodyInput = find<HTMLElement>('.pss-body-input')
    const bodyCopy = find<HTMLElement>('.pss-body-copy')
    const bodyCaret = find<HTMLElement>('.pss-body-caret')
    const submitIssue = find<HTMLElement>('.pss-submit-issue')
    const composer = find<HTMLElement>('.pss-composer')
    const createdIssue = find<HTMLElement>('.pss-created-issue')
    const botComment = find<HTMLElement>('.pss-bot-comment')
    const priorityEvent = find<HTMLElement>('.pss-priority-event')
    const createdEntitlement = find<HTMLElement>('.pss-created-entitlement')
    const notification = find<HTMLElement>('.pss-priority-notification')
    const supportMail = find<HTMLElement>('.pss-mail-window')
    const supportMailIcon = find<HTMLElement>('.pss-support-mail-icon')
    const supportCode = find<HTMLElement>('.pss-code-window')
    const supportCodeIcon = find<HTMLElement>('.pss-support-code-icon')
    const supportBrowser = find<HTMLElement>('.pss-support-browser')
    const supportBrowserIcon = find<HTMLElement>('.pss-support-browser-icon')
    const supportAddress = find<HTMLElement>('.pss-support-address')
    const supportIssuesCount = find<HTMLElement>('.pss-support-issues-count')
    const statuses = Array.from(root.querySelectorAll<HTMLElement>('.pss-code-status'))
    const thinking = find<HTMLElement>('.pss-status-thinking')
    const hacking = find<HTMLElement>('.pss-status-hacking')
    const openingPr = find<HTMLElement>('.pss-status-opening')
    const matrix = find<HTMLCanvasElement>('.pss-matrix')
    const prView = find<HTMLElement>('.pss-pr-view')
    const supportIssuesTab = find<HTMLElement>('.pss-support-issues-tab')
    const mergeButton = find<HTMLElement>('.pss-merge-button')
    const mergeReady = find<HTMLElement>('.pss-merge-ready')
    const confirmMerge = find<HTMLElement>('.pss-confirm-merge')
    const confirmButton = find<HTMLElement>('.pss-confirm-button')
    const mergedState = find<HTMLElement>('.pss-merged-state')
    const prOpenPill = find<HTMLElement>('.pss-pr-open-pill')
    const prMergedPill = find<HTMLElement>('.pss-pr-merged-pill')
    const prOpenMeta = find<HTMLElement>('.pss-pr-open-meta')
    const prMergedMeta = find<HTMLElement>('.pss-pr-merged-meta')
    const mergeBox = find<HTMLElement>('.pss-merge-box')
    const issuesList = find<HTMLElement>('.pss-support-issues-list')
    const priorityIssueRow = find<HTMLElement>('.pss-priority-issue-row')
    const issueView = find<HTMLElement>('.pss-support-issue')
    const supportReply = find<HTMLElement>('.pss-support-reply')
    const replyStack = find<HTMLElement>('.pss-reply-stack')
    const replyComposer = find<HTMLElement>('.pss-reply-composer')
    const replyDraft = find<HTMLElement>('.pss-reply-draft')
    const replyCaret = find<HTMLElement>('.pss-reply-caret')
    const postedReply = find<HTMLElement>('.pss-posted-reply')
    const closeButton = find<HTMLElement>('.pss-close-button')
    const openPill = find<HTMLElement>('.pss-open-pill')
    const closedPill = find<HTMLElement>('.pss-closed-pill')
    const closedEvent = find<HTMLElement>('.pss-closed-event')
    const thanksComment = find<HTMLElement>('.pss-thanks-comment')
    const threadViewport = find<HTMLElement>('.pss-support-thread-viewport')
    const threadTrack = find<HTMLElement>('.pss-support-thread-track')
    const dockIcons = Array.from(root.querySelectorAll<HTMLElement>('.pss-dock-icon'))

    if (!userMachine || !supportMachine || !pointer || !pointerRing || !userBrowser || !userBrowserIcon || !userAddress || !userIssuesCount || !titleInput || !titleCopy || !titleCaret || !bodyInput || !bodyCopy || !bodyCaret || !submitIssue || !composer || !createdIssue || !botComment || !priorityEvent || !createdEntitlement || !notification || !supportMail || !supportMailIcon || !supportCode || !supportCodeIcon || !supportBrowser || !supportBrowserIcon || !supportAddress || !supportIssuesCount || !thinking || !hacking || !openingPr || !matrix || !prView || !supportIssuesTab || !mergeButton || !mergeReady || !confirmMerge || !confirmButton || !mergedState || !prOpenPill || !prMergedPill || !prOpenMeta || !prMergedMeta || !mergeBox || !issuesList || !priorityIssueRow || !issueView || !supportReply || !replyStack || !replyComposer || !replyDraft || !replyCaret || !postedReply || !closeButton || !openPill || !closedPill || !closedEvent || !thanksComment || !threadViewport || !threadTrack)
      return

    const pointFor = (target: HTMLElement) => {
      const rootRect = root.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      return {
        x: targetRect.left - rootRect.left + targetRect.width / 2 - 3,
        y: targetRect.top - rootRect.top + targetRect.height / 2 - 2,
      }
    }
    const deltaFrom = (windowEl: HTMLElement, iconEl: HTMLElement) => {
      const windowRect = windowEl.getBoundingClientRect()
      const iconRect = iconEl.getBoundingClientRect()
      return {
        x: iconRect.left + iconRect.width / 2 - (windowRect.left + windowRect.width / 2),
        y: iconRect.top + iconRect.height / 2 - (windowRect.top + windowRect.height / 2),
      }
    }

    const timeline = gsap.timeline({
      paused: true,
      onComplete: () => {
        storyComplete.value = true
      },
    })
    storyTimeline = timeline

    const movePointer = (target: HTMLElement, at: number, duration = 0.55) => {
      timeline.to(pointer, {
        autoAlpha: 1,
        x: () => pointFor(target).x,
        y: () => pointFor(target).y,
        duration,
        ease: 'power2.inOut',
      }, at)
    }
    const clickTarget = (target: HTMLElement, at: number) => {
      timeline
        .to(pointer, { scale: 0.88, duration: 0.09, ease: 'power1.in' }, at)
        .to(target, { scale: 0.94, duration: 0.09, ease: 'power1.in' }, at)
        .fromTo(pointerRing, { autoAlpha: 0.8, scale: 0.25 }, { autoAlpha: 0, scale: 1.45, duration: 0.24, ease: 'power2.out' }, at)
        .to(pointer, { scale: 1, duration: 0.12, ease: 'power1.out' }, at + 0.09)
        .to(target, { scale: 1, duration: 0.13, ease: 'power1.out' }, at + 0.09)
    }
    const clickDockIcon = (at: number) => {
      timeline
        .to(pointer, { scale: 0.88, duration: 0.09, ease: 'power1.in' }, at)
        .fromTo(pointerRing, { autoAlpha: 0.8, scale: 0.25 }, { autoAlpha: 0, scale: 1.45, duration: 0.26, ease: 'power2.out' }, at)
        .to(pointer, { scale: 1, duration: 0.12, ease: 'power1.out' }, at + 0.09)
    }
    const magnifyDockIcon = (icon: HTMLElement, at: number) => {
      timeline.to(icon, {
        scale: 1.28,
        y: -6,
        duration: 0.25,
        ease: 'back.out(2)',
        onUpdate: () => {
          const point = pointFor(icon)
          gsap.set(pointer, { x: point.x, y: point.y })
        },
      }, at)
    }
    const restoreDockIcon = (icon: HTMLElement, at: number) => {
      timeline.to(icon, {
        scale: 1,
        y: 0,
        duration: 0.28,
        ease: 'power2.out',
        onUpdate: () => {
          const point = pointFor(icon)
          gsap.set(pointer, { x: point.x, y: point.y })
        },
      }, at)
    }
    const openFromDock = (windowEl: HTMLElement, iconEl: HTMLElement, at: number, duration = 0.46) => {
      timeline.fromTo(windowEl, {
        autoAlpha: 0,
        scale: 0.16,
        x: () => deltaFrom(windowEl, iconEl).x,
        y: () => deltaFrom(windowEl, iconEl).y,
        transformOrigin: '50% 100%',
      }, {
        autoAlpha: 1,
        scale: 1,
        x: 0,
        y: 0,
        duration,
        ease: 'back.out(1.18)',
      }, at)
    }
    const showStatus = (status: HTMLElement, at: number) => {
      timeline.fromTo(status, { autoAlpha: 0, y: 13, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, ease: 'power3.out' }, at)
    }
    const typeText = (target: HTMLElement, caret: HTMLElement, copy: string, at: number, duration: number) => {
      const characters = Array.from(copy)
      const stops: number[] = []
      let totalWeight = 0
      characters.forEach((character) => {
        totalWeight += character === ' ' ? 0.45 : 1
        stops.push(totalWeight)
        if (/[.!?]/.test(character))
          totalWeight += 3.2
        else if (/[,;:]/.test(character))
          totalWeight += 1.8
      })
      const progress = { weight: 0 }
      timeline
        .set(caret, { autoAlpha: 1 }, at)
        .fromTo(progress, { weight: 0 }, {
          weight: totalWeight,
          duration,
          ease: 'none',
          onStart: () => {
            target.textContent = ''
          },
          onUpdate: () => {
            let visibleCharacters = 0
            while (visibleCharacters < stops.length && progress.weight >= stops[visibleCharacters])
              visibleCharacters += 1
            target.textContent = characters.slice(0, visibleCharacters).join('')
          },
          onComplete: () => {
            target.textContent = copy
          },
        }, at)
        .to(caret, { autoAlpha: 0, duration: 0.12 }, at + duration)
    }
    const setText = (target: HTMLElement, copy: string) => {
      target.textContent = copy
    }
    const scrollThreadTo = (target: HTMLElement, at: number, padding = 7) => {
      timeline.to(threadTrack, {
        y: () => {
          const viewportRect = threadViewport.getBoundingClientRect()
          const targetRect = target.getBoundingClientRect()
          const currentY = Number.parseFloat(String(gsap.getProperty(threadTrack, 'y'))) || 0
          const overflow = targetRect.bottom - (viewportRect.bottom - padding)
          return overflow > 0 ? currentY - overflow : currentY
        },
        duration: 0.44,
        ease: 'power2.inOut',
      }, at)
    }

    const issueTitle = t('priority-support-story-microsoft-title')
    const issueBody = t('priority-support-story-microsoft-body')
    const maintainerReply = t('priority-support-story-maintainer-reply')

    const resetVisualState = () => {
      stopMatrix()
      gsap.set(userMachine, { autoAlpha: 1, xPercent: 0 })
      gsap.set(supportMachine, { autoAlpha: 1, xPercent: 100 })
      gsap.set(pointer, { autoAlpha: 0, x: 8, y: root.clientHeight - 35, scale: 1 })
      gsap.set(pointerRing, { autoAlpha: 0, scale: 1 })
      gsap.set(dockIcons, { scale: 1, y: 0 })
      gsap.set(userBrowser, { autoAlpha: 0, scale: 1, x: 0, y: 0 })
      gsap.set(composer, { autoAlpha: 1, x: 0 })
      gsap.set(createdIssue, { autoAlpha: 0, x: 0 })
      gsap.set([botComment, priorityEvent, createdEntitlement], { autoAlpha: 0, y: 10 })
      gsap.set([notification, supportMail, supportCode, supportBrowser], { autoAlpha: 0, x: 0, y: 0, scale: 1 })
      gsap.set([confirmMerge, mergedState, prMergedPill, prMergedMeta, supportReply, postedReply, closedPill, closedEvent, thanksComment], { autoAlpha: 0, x: 0, y: 0, scale: 1 })
      gsap.set([issuesList, issueView], { autoAlpha: 0, x: 0 })
      gsap.set([titleCaret, bodyCaret, replyCaret], { autoAlpha: 0 })
      gsap.set(statuses, { autoAlpha: 0, x: 0, y: 0, xPercent: -50, yPercent: -50, scale: 1 })
      gsap.set(prView, { autoAlpha: 1, x: 0 })
      gsap.set(mergeReady, { autoAlpha: 1, y: 0 })
      gsap.set(mergeBox, { borderColor: '#238636', backgroundColor: 'rgba(35,134,54,.06)' })
      gsap.set([prOpenPill, prOpenMeta], { autoAlpha: 1, y: 0 })
      gsap.set(replyStack, { minHeight: 94 })
      gsap.set(replyComposer, { autoAlpha: 1, display: 'block' })
      gsap.set(openPill, { autoAlpha: 1 })
      gsap.set([titleInput, bodyInput], { borderColor: '#30363d', boxShadow: 'none', scale: 1 })
      gsap.set([submitIssue, supportIssuesTab, priorityIssueRow, mergeButton, confirmButton, closeButton], { autoAlpha: 1, scale: 1 })
      gsap.set(matrix, { autoAlpha: 0 })
      gsap.set(threadTrack, { y: 0 })
      setText(userAddress, 'github.com/Cap-go/capacitor-social-login/issues/new')
      setText(supportAddress, 'github.com/Cap-go/capacitor-social-login/pull/482')
      setText(userIssuesCount, '12')
      setText(supportIssuesCount, '13')
      titleCopy.textContent = ''
      bodyCopy.textContent = ''
      replyDraft.textContent = ''
    }

    resetVisualState()
    timeline.call(resetVisualState, [], 0)

    if (reduce) {
      timeline.kill()
      storyTimeline = null
      gsap.set(userMachine, { autoAlpha: 0 })
      gsap.set(supportMachine, { autoAlpha: 1, xPercent: 0 })
      gsap.set(supportBrowser, { autoAlpha: 1, scale: 1, x: 0, y: 0 })
      gsap.set([prView, issuesList, openPill, replyComposer], { autoAlpha: 0 })
      gsap.set([issueView, supportReply, postedReply, closedPill, closedEvent, thanksComment], { autoAlpha: 1, y: 0 })
      setText(supportAddress, 'github.com/Cap-go/capacitor-social-login/issues/418')
      setText(replyDraft, maintainerReply)
      gsap.set(replyStack, { minHeight: 48 })
      gsap.set(replyComposer, { autoAlpha: 0, display: 'none' })
      const overflow = thanksComment.getBoundingClientRect().bottom - (threadViewport.getBoundingClientRect().bottom - 7)
      if (overflow > 0)
        gsap.set(threadTrack, { y: -overflow })
      return
    }

    movePointer(userBrowserIcon, 0.3, 0.42)
    magnifyDockIcon(userBrowserIcon, 0.74)
    clickDockIcon(0.9)
    openFromDock(userBrowser, userBrowserIcon, 0.98, 0.52)
    restoreDockIcon(userBrowserIcon, 1.18)

    movePointer(titleInput, 1.62, 0.38)
    clickTarget(titleInput, 2.02)
    timeline.to(titleInput, { borderColor: '#1f6feb', boxShadow: '0 0 0 2px rgba(31,111,235,.28)', duration: 0.18 }, 2.03)
    typeText(titleCopy, titleCaret, issueTitle, 2.16, 1.55)
    movePointer(bodyInput, 3.78, 0.22)
    clickTarget(bodyInput, 4.04)
    timeline
      .to(titleInput, { borderColor: '#30363d', boxShadow: 'none', duration: 0.16 }, 4.04)
      .to(bodyInput, { borderColor: '#1f6feb', boxShadow: '0 0 0 2px rgba(31,111,235,.28)', duration: 0.18 }, 4.04)
    typeText(bodyCopy, bodyCaret, issueBody, 4.17, 2.75)
    movePointer(submitIssue, 6.94, 0.22)
    clickTarget(submitIssue, 7.2)
    timeline
      .to(bodyInput, { borderColor: '#30363d', boxShadow: 'none', duration: 0.16 }, 7.2)
      .to(composer, { autoAlpha: 0, x: -12, duration: 0.28, ease: 'power2.in' }, 7.32)
      .to(pointer, { autoAlpha: 0, duration: 0.14 }, 7.32)
      .call(() => {
        setText(userAddress, 'github.com/Cap-go/capacitor-social-login/issues/418')
        setText(userIssuesCount, '13')
      }, [], 7.44)
      .fromTo(createdIssue, { autoAlpha: 0, x: 14 }, { autoAlpha: 1, x: 0, duration: 0.36, ease: 'power3.out' }, 7.48)
      .fromTo(botComment, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.38, ease: 'power3.out' }, 7.92)
      .fromTo(priorityEvent, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: 'power3.out' }, 8.38)
      .fromTo(createdEntitlement, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power3.out' }, 8.42)
      .to(userMachine, { xPercent: -100, duration: 0.5, ease: 'power2.inOut' }, 9.3)
      .to(supportMachine, { xPercent: 0, duration: 0.5, ease: 'power2.inOut' }, 9.3)
      .fromTo(notification, { autoAlpha: 0, x: 34, y: -8 }, { autoAlpha: 1, x: 0, y: 0, duration: 0.36, ease: 'back.out(1.55)' }, 9.9)

    movePointer(notification, 10.34, 0.25)
    clickTarget(notification, 10.68)
    timeline.to(notification, { autoAlpha: 0, x: 22, duration: 0.22, ease: 'power2.in' }, 10.85)
    openFromDock(supportMail, notification, 10.88, 0.42)
    movePointer(supportCodeIcon, 11.72, 0.25)
    magnifyDockIcon(supportCodeIcon, 12)
    clickDockIcon(12.27)
    timeline.to(supportMail, { autoAlpha: 0, scale: 0.97, duration: 0.24, ease: 'power2.in' }, 12.39)
    openFromDock(supportCode, supportCodeIcon, 12.43, 0.44)
    restoreDockIcon(supportCodeIcon, 12.68)
    timeline.to(pointer, { autoAlpha: 0, duration: 0.16 }, 12.92)
    showStatus(thinking, 13)
    timeline.to(thinking, { autoAlpha: 0, y: -10, duration: 0.24, ease: 'power2.in' }, 14)
    showStatus(hacking, 14.34)
    timeline
      .call(startMatrix, [], 14.34)
      .to(matrix, { autoAlpha: 0.82, duration: 0.25 }, 14.34)
      .to(hacking, { autoAlpha: 0, y: -10, duration: 0.24, ease: 'power2.in' }, 15.62)
      .to(matrix, { autoAlpha: 0, duration: 0.24 }, 15.62)
      .call(stopMatrix, [], 15.88)
    showStatus(openingPr, 15.98)
    timeline
      .to(openingPr, { autoAlpha: 0, y: -10, duration: 0.24, ease: 'power2.in' }, 16.92)
      .to(supportCode, { autoAlpha: 0, scale: 0.97, duration: 0.25, ease: 'power2.in' }, 17.36)
    movePointer(supportBrowserIcon, 16.75, 0.24)
    magnifyDockIcon(supportBrowserIcon, 17.01)
    clickDockIcon(17.28)
    openFromDock(supportBrowser, supportBrowserIcon, 17.4, 0.44)
    restoreDockIcon(supportBrowserIcon, 17.62)
    movePointer(mergeButton, 18.12, 0.25)
    clickTarget(mergeButton, 18.45)
    timeline
      .to(mergeReady, { autoAlpha: 0, y: -6, duration: 0.2, ease: 'power2.in' }, 18.7)
      .fromTo(confirmMerge, { autoAlpha: 0, y: 7 }, { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power3.out' }, 18.74)
    movePointer(confirmButton, 19.12, 0.24)
    clickTarget(confirmButton, 19.44)
    timeline
      .to(confirmMerge, { autoAlpha: 0, y: -6, duration: 0.18 }, 19.7)
      .to(mergeBox, { borderColor: '#8250df', backgroundColor: 'rgba(130,80,223,.08)', duration: 0.28 }, 19.72)
      .fromTo(mergedState, { autoAlpha: 0, scale: 0.96 }, { autoAlpha: 1, scale: 1, duration: 0.32, ease: 'back.out(1.3)' }, 19.76)
      .to([prOpenPill, prOpenMeta], { autoAlpha: 0, duration: 0.16 }, 19.76)
      .fromTo([prMergedPill, prMergedMeta], { autoAlpha: 0, y: 3 }, { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power3.out' }, 19.82)
      .to(pointer, { autoAlpha: 0, duration: 0.14 }, 19.8)

    movePointer(supportIssuesTab, 20.5, 0.25)
    clickTarget(supportIssuesTab, 20.83)
    timeline
      .to(prView, { autoAlpha: 0, x: -12, duration: 0.28, ease: 'power2.in' }, 21.08)
      .call(() => setText(supportAddress, 'github.com/Cap-go/capacitor-social-login/issues'), [], 21.17)
      .fromTo(issuesList, { autoAlpha: 0, x: 14 }, { autoAlpha: 1, x: 0, duration: 0.34, ease: 'power3.out' }, 21.2)

    movePointer(priorityIssueRow, 22, 0.26)
    clickTarget(priorityIssueRow, 22.34)
    timeline
      .to(issuesList, { autoAlpha: 0, x: -12, duration: 0.28, ease: 'power2.in' }, 22.58)
      .call(() => setText(supportAddress, 'github.com/Cap-go/capacitor-social-login/issues/418'), [], 22.68)
      .fromTo(issueView, { autoAlpha: 0, x: 14 }, { autoAlpha: 1, x: 0, duration: 0.36, ease: 'power3.out' }, 22.7)
      .fromTo(supportReply, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.34, ease: 'power3.out' }, 23.16)

    scrollThreadTo(closeButton, 23.9)
    movePointer(replyComposer, 24.45, 0.26)
    clickTarget(replyComposer, 24.79)
    typeText(replyDraft, replyCaret, maintainerReply, 24.93, 2.2)
    movePointer(closeButton, 27.2, 0.26)
    clickTarget(closeButton, 27.54)
    timeline
      .to(replyComposer, { autoAlpha: 0, duration: 0.18 }, 27.82)
      .set(replyComposer, { display: 'none' }, 28)
      .fromTo(postedReply, { autoAlpha: 0, y: 5 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power3.out' }, 28)
      .to(replyStack, { minHeight: () => postedReply.offsetHeight, duration: 0.3, ease: 'power2.inOut' }, 28)
      .to(openPill, { autoAlpha: 0, duration: 0.16 }, 28.01)
      .fromTo(closedPill, { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.28, ease: 'back.out(1.4)' }, 28.06)
      .call(() => setText(supportIssuesCount, '12'), [], 28.06)
      .fromTo(closedEvent, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power3.out' }, 28.3)
      .to(pointer, { autoAlpha: 0, duration: 0.14 }, 28.04)
    scrollThreadTo(thanksComment, 28.64)
    timeline
      .fromTo(thanksComment, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.42, ease: 'back.out(1.3)' }, 29.18)

    timeline.play(0)
  }, root)
}

watch(() => props.active, async (active) => {
  if (!active) {
    stopStory()
    return
  }
  await nextTick()
  startStory()
}, { immediate: true })

onBeforeUnmount(stopStory)
</script>

<template>
  <div
    ref="rootEl"
    class="pss-story"
    :class="{ 'is-replayable': !reduce }"
    :role="reduce ? 'img' : 'button'"
    :tabindex="reduce ? undefined : 0"
    :aria-label="t(reduce ? 'priority-support-story-example-flow' : 'priority-support-story-replay')"
    @click="replayStory"
    @keydown.enter.prevent="replayStory"
    @keydown.space.prevent="replayStory"
  >
    <div class="pss-example-label" :class="{ 'is-replay': storyComplete }">
      <span v-if="storyComplete" aria-hidden="true">↻</span>
      {{ t(storyComplete ? 'priority-support-story-replay' : 'priority-support-story-example-flow') }}
    </div>

    <section class="pss-machine pss-user-machine">
      <div class="pss-desktop pss-user-desktop">
        <div class="pss-menu-bar">
          <b>●</b><strong>{{ t('priority-support-story-your-mac') }}</strong><span>GitHub</span><i>⌁ ◉ 09:41</i>
        </div>

        <div class="pss-window pss-browser-window pss-user-browser">
          <div class="pss-browser-chrome">
            <div class="pss-traffic">
              <i /><i /><i />
            </div>
            <div class="pss-browser-actions">
              <span>‹</span><span>›</span>
            </div>
            <div class="pss-address pss-user-address">
              github.com/Cap-go/capacitor-social-login/issues/new
            </div>
          </div>
          <div class="pss-github-global">
            <IconGithub /><div class="pss-gh-search">
              {{ t('priority-support-story-search') }}
            </div><span>⌕</span><span>＋</span><b>AM</b>
          </div>
          <div class="pss-repo-line">
            <IconGithub /><span>Cap-go</span><b>/</b><strong>capacitor-social-login</strong><em>{{ t('priority-support-story-public') }}</em>
          </div>
          <div class="pss-repo-tabs">
            <span>{{ t('priority-support-story-code') }}</span><span class="selected">{{ t('priority-support-story-issues') }} <b class="pss-user-issues-count">12</b></span><span>{{ t('priority-support-story-pull-requests') }} <b>3</b></span><span>{{ t('priority-support-story-actions') }}</span>
          </div>

          <div class="pss-github-page pss-composer">
            <div class="pss-create-heading">
              <h3>{{ t('priority-support-story-new-issue') }}</h3><span>{{ t('priority-support-story-feature-request') }}</span>
            </div>
            <div class="pss-composer-grid">
              <div class="pss-avatar pss-avatar-user">
                AM
              </div>
              <div class="pss-compose-card">
                <label>{{ t('priority-support-story-add-title') }}</label>
                <div class="pss-title-input">
                  <span class="pss-title-copy" /><i class="pss-typing-caret pss-title-caret" />
                </div>
                <div class="pss-composer-tabs">
                  <b>{{ t('priority-support-story-write') }}</b><span>{{ t('priority-support-story-preview') }}</span>
                </div>
                <div class="pss-markdown-tools">
                  <b>B</b><i>I</i><span>&lt;&gt;</span><span>↗</span><span>•—</span><span>☑</span>
                </div>
                <div class="pss-body-input">
                  <span class="pss-body-copy" /><i class="pss-typing-caret pss-body-caret" />
                </div>
                <span class="pss-submit-issue">
                  {{ t('priority-support-story-submit') }}
                </span>
              </div>
              <aside class="pss-issue-meta">
                <b>{{ t('priority-support-story-assignees') }}</b><span>{{ t('priority-support-story-no-one') }}</span><b>{{ t('priority-support-story-labels') }}</b><em>{{ t('priority-support-story-feature-request') }}</em><b>{{ t('priority-support-story-projects') }}</b><span>{{ t('priority-support-story-none-yet') }}</span>
              </aside>
            </div>
          </div>

          <div class="pss-github-page pss-created-issue">
            <div class="pss-issue-title">
              <h3>{{ t('priority-support-story-microsoft-title') }} <span>#418</span></h3>
              <div><em>{{ t('priority-support-story-open') }}</em><span>{{ t('priority-support-story-opened-issue-now') }}</span></div>
            </div>
            <div class="pss-issue-layout">
              <div class="pss-timeline">
                <div class="pss-comment-row">
                  <div class="pss-avatar pss-avatar-user">
                    AM
                  </div>
                  <div class="pss-comment-card">
                    <header><b>acme-mobile</b><span>{{ t('priority-support-story-commented-now') }}</span><i>{{ t('priority-support-story-author') }}</i></header>
                    <p>{{ t('priority-support-story-microsoft-body') }}</p>
                  </div>
                </div>
                <div class="pss-comment-row pss-bot-comment">
                  <div class="pss-avatar pss-avatar-bot">
                    ✦
                  </div>
                  <div class="pss-comment-card pss-bot-card">
                    <header><b>capgo-bot</b><i>{{ t('priority-support-story-bot') }}</i><span>{{ t('priority-support-story-commented-now') }}</span></header>
                    <p>{{ t('priority-support-story-bot-reply') }}</p>
                  </div>
                </div>
                <div class="pss-issue-event pss-priority-event">
                  <span>⚡</span><p>{{ t('priority-support-story-priority-assigned-event') }}</p>
                </div>
              </div>
              <aside class="pss-issue-sidebar pss-created-entitlement">
                <b>{{ t('priority-support-story-assignees') }}</b><span>{{ t('priority-support-story-capgo-support') }}</span><b>{{ t('priority-support-story-labels') }}</b><em>{{ t('priority-support-story-feature-request') }}</em><em>{{ t('priority-support-story-priority-support') }}</em><b>{{ t('priority-support-story-development') }}</b><span>{{ t('priority-support-story-no-branches-yet') }}</span>
              </aside>
            </div>
          </div>
        </div>

        <div class="pss-dock">
          <span class="pss-dock-icon pss-safari pss-user-browser-icon"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="#fff" /><circle cx="32" cy="32" r="23" fill="#2ca7ef" /><path d="m38 20-4 14-8 10 4-14z" fill="#f43f5e" /><path d="m26 44 4-14 8-10-4 14z" fill="#fff" /><circle cx="32" cy="32" r="3" fill="#172554" /></svg><i /></span>
          <span class="pss-dock-icon pss-files"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="9" y="13" width="46" height="39" rx="9" fill="#d6efff" /><path d="M9 24h46v28H9z" fill="#4f9fe8" /><path d="M14 13h16l5 7H14z" fill="#fff" opacity=".8" /></svg></span>
        </div>
      </div>
    </section>

    <section class="pss-machine pss-support-machine">
      <div class="pss-desktop pss-support-desktop">
        <div class="pss-menu-bar">
          <b>●</b><strong>{{ t('priority-support-story-support-mac') }}</strong><span>{{ t('priority-support-story-finder') }}</span><i>⌁ ◉ 09:42</i>
        </div>

        <div class="pss-notification pss-priority-notification">
          <div class="pss-mail-app-icon">
            <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="7" width="40" height="34" rx="8" fill="#168cf5" /><path d="m8 13 16 13 16-13" fill="none" stroke="#fff" stroke-width="3" /></svg>
          </div>
          <div><header><b>{{ t('priority-support-story-mail') }}</b><span>{{ t('priority-support-story-now') }}</span></header><strong>{{ t('priority-support-story-notification-title') }}</strong><p>{{ t('priority-support-story-notification-body') }}</p></div>
        </div>

        <div class="pss-window pss-mail-window">
          <div class="pss-mac-titlebar">
            <div class="pss-traffic">
              <i /><i /><i />
            </div><strong>{{ t('priority-support-story-mail') }}</strong><span>⌕</span>
          </div>
          <div class="pss-mail-layout">
            <aside class="pss-mailboxes">
              <b>{{ t('priority-support-story-favorites') }}</b><span class="selected">▰ {{ t('priority-support-story-inbox') }} <i>4</i></span><span>☆ {{ t('priority-support-story-priority') }}</span><span>⌁ {{ t('priority-support-story-sent') }}</span><b>{{ t('priority-support-story-on-my-mac') }}</b><span>{{ t('priority-support-story-archive') }}</span>
            </aside>
            <div class="pss-message-list">
              <header>{{ t('priority-support-story-inbox') }} <b>4</b></header><div class="selected">
                <b>Capgo Bot</b><time>09:42</time><strong>{{ t('priority-support-story-email-subject') }}</strong><p>{{ t('priority-support-story-email-snippet') }}</p>
              </div><div><b>GitHub</b><time>09:31</time><strong>{{ t('priority-support-story-release-published') }}</strong><p>capacitor-social-login v7.2.1</p></div><div><b>Capgo</b><time>{{ t('priority-support-story-yesterday') }}</time><strong>{{ t('priority-support-story-support-digest') }}</strong><p>{{ t('priority-support-story-issues-resolved') }}</p></div>
            </div>
            <article class="pss-mail-reading">
              <header><h3>{{ t('priority-support-story-email-subject') }}</h3><span>{{ t('priority-support-story-email-from') }}</span></header><div class="pss-email-brand">
                <b>✦ Capgo</b><em>{{ t('priority-support-story-priority-support') }}</em>
              </div><p class="pss-mail-account">
                {{ emailAccount }}
              </p><h4>{{ t('priority-support-story-microsoft-title') }}</h4><p>{{ t('priority-support-story-microsoft-body') }}</p><span class="pss-open-github">
                {{ t('priority-support-story-open-github') }}
              </span>
            </article>
          </div>
        </div>

        <div class="pss-window pss-code-window">
          <div class="pss-code-titlebar">
            <span>‹ ›</span><div>capacitor-social-login — Visual Studio Code</div><i>— □ ×</i>
          </div>
          <div class="pss-vscode-layout">
            <nav class="pss-activity-bar">
              <svg viewBox="0 0 24 24"><path d="M5 3h10l4 4v14H5zM14 3v5h5" /></svg><svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v8a4 4 0 0 0 4 4h6M16 5l-4-2v4z" /></svg><svg viewBox="0 0 24 24"><path d="M5 4h14v13H5zM9 21h6M12 17v4" /></svg>
            </nav>
            <aside class="pss-explorer">
              <header>{{ t('priority-support-story-explorer') }} <b>•••</b></header><strong>CAPACITOR-SOCIAL-LOGIN</strong><span>⌄ android</span><span class="indent">⌄ src</span><span class="indent2 active">MicrosoftAuth.kt</span><span class="indent2">SocialLoginPlugin.kt</span><span>› ios</span><span>› src</span><span>package.json</span><span>README.md</span>
            </aside>
            <main class="pss-editor">
              <div class="pss-code-tabs">
                <span class="active">MicrosoftAuth.kt <i>×</i></span><span>SocialLoginPlugin.kt <i>×</i></span>
              </div>
              <div class="pss-breadcrumbs">
                android › src › MicrosoftAuth.kt
              </div>
              <div class="pss-editor-canvas">
                <div class="pss-line-numbers">
                  1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9<br>10<br>11<br>12
                </div>
                <div class="pss-code-skeleton">
                  <i class="wide" /><i /><i class="medium" /><i class="short" /><i /><i class="wide" /><i class="short" /><i class="medium" /><i /><i class="short" />
                </div>
                <canvas ref="matrixEl" class="pss-matrix" />
                <div class="pss-code-status pss-status-thinking">
                  <span class="pss-spinner" />{{ t('priority-support-story-thinking') }}…
                </div>
                <div class="pss-code-status pss-status-hacking">
                  <span class="pss-terminal-caret">›_</span>{{ t('priority-support-story-hacking') }}…
                </div>
                <div class="pss-code-status pss-status-opening">
                  <span class="pss-pr-icon">⑂</span>{{ t('priority-support-story-opening-pr') }}…
                </div>
              </div>
              <div class="pss-panel">
                <header><b>{{ t('priority-support-story-problems') }}</b><span>{{ t('priority-support-story-output') }}</span><span>{{ t('priority-support-story-terminal') }}</span><span>{{ t('priority-support-story-ports') }}</span></header><p><i>✓</i> {{ t('priority-support-story-tests-passed') }}</p>
              </div>
            </main>
          </div>
          <div class="pss-status-bar">
            <span>⑂ main*</span><span>✓ 0&nbsp;&nbsp; ⚠ 0</span><i>{{ t('priority-support-story-editor-status') }}</i>
          </div>
        </div>

        <div class="pss-window pss-browser-window pss-support-browser">
          <div class="pss-browser-chrome">
            <div class="pss-traffic">
              <i /><i /><i />
            </div><div class="pss-browser-actions">
              <span>‹</span><span>›</span>
            </div><div class="pss-address pss-support-address">
              github.com/Cap-go/capacitor-social-login/pull/482
            </div>
          </div>
          <div class="pss-github-global">
            <IconGithub /><div class="pss-gh-search">
              {{ t('priority-support-story-search') }}
            </div><span>⌕</span><span>＋</span><b>CG</b>
          </div>
          <div class="pss-repo-line">
            <IconGithub /><span>Cap-go</span><b>/</b><strong>capacitor-social-login</strong><em>{{ t('priority-support-story-public') }}</em>
          </div>

          <div class="pss-pr-view">
            <div class="pss-repo-tabs">
              <span>{{ t('priority-support-story-code') }}</span><span class="pss-support-issues-tab">{{ t('priority-support-story-issues') }} <b>13</b></span><span class="selected">{{ t('priority-support-story-pull-requests') }} <b>3</b></span><span>{{ t('priority-support-story-actions') }}</span>
            </div>
            <div class="pss-pr-heading">
              <h3>{{ t('priority-support-story-pr-title') }} <span>#482</span></h3>
              <div>
                <span class="pss-pr-status-slot"><em class="pss-pr-open-pill">{{ t('priority-support-story-open') }}</em><em class="pss-pr-merged-pill">✓ {{ t('priority-support-story-merged') }}</em></span>
                <span class="pss-pr-meta-slot"><span class="pss-pr-open-meta">{{ t('priority-support-story-wants-to-merge') }}</span><span class="pss-pr-merged-meta">{{ t('priority-support-story-merged-commits') }}</span></span>
              </div>
            </div>
            <div class="pss-pr-tabs">
              <b>{{ t('priority-support-story-conversation') }}</b><span>{{ t('priority-support-story-commits') }} 3</span><span>{{ t('priority-support-story-checks-tab') }} 8</span><span>{{ t('priority-support-story-files-changed') }} 5</span>
            </div>
            <div class="pss-pr-body">
              <div class="pss-pr-summary">
                <div class="pss-avatar pss-avatar-capgo">
                  CG
                </div><div><b>capgo-support</b><span>{{ t('priority-support-story-commented-now') }}</span><p>{{ t('priority-support-story-pr-summary') }}</p><small>{{ t('priority-support-story-refs') }} #418</small></div>
              </div><div class="pss-merge-box">
                <div class="pss-merge-state pss-merge-ready">
                  <header><span>✓</span><div><b>{{ t('priority-support-story-checks') }}</b><small>{{ t('priority-support-story-ready') }}</small></div></header>
                  <p><span>✓</span> {{ t('priority-support-story-no-conflicts') }}</p>
                  <span class="pss-merge-button">
                    {{ t('priority-support-story-merge') }}
                  </span>
                </div>
                <div class="pss-merge-state pss-confirm-merge">
                  <b>{{ t('priority-support-story-confirm-merge') }}</b><span>{{ t('priority-support-story-create-merge-commit') }}</span><span class="pss-confirm-button">
                    {{ t('priority-support-story-confirm-merge') }}
                  </span>
                </div>
                <div class="pss-merge-state pss-merged-state">
                  <span class="pss-merged-icon">✓</span><div><b>{{ t('priority-support-story-merge-success') }}</b><span>{{ t('priority-support-story-safe-delete') }}</span></div>
                </div>
              </div>
            </div>
          </div>

          <div class="pss-support-issues-list">
            <div class="pss-repo-tabs">
              <span>{{ t('priority-support-story-code') }}</span><span class="selected">{{ t('priority-support-story-issues') }} <b>13</b></span><span>{{ t('priority-support-story-pull-requests') }} <b>2</b></span><span>{{ t('priority-support-story-actions') }}</span>
            </div>
            <div class="pss-issues-toolbar">
              <div><b>● 13 {{ t('priority-support-story-open') }}</b><span>✓ 38 {{ t('priority-support-story-closed') }}</span></div><span class="pss-list-new-issue">
                {{ t('priority-support-story-new-issue') }}
              </span>
            </div>
            <div class="pss-issues-list-head">
              <span>{{ t('priority-support-story-author') }}</span><span>{{ t('priority-support-story-label') }}</span><span>{{ t('priority-support-story-projects') }}</span><span>{{ t('priority-support-story-milestones') }}</span><span>{{ t('priority-support-story-assignee') }}</span>
            </div>
            <div class="pss-support-issue-row pss-priority-issue-row">
              <span class="pss-open-icon">◉</span><div><strong>{{ t('priority-support-story-microsoft-title') }}</strong><p>#418 {{ t('priority-support-story-opened-now-by-acme') }}</p></div><aside><em>{{ t('priority-support-story-feature-request') }}</em><em class="priority">{{ t('priority-support-story-priority-support') }}</em><b>CG</b></aside>
            </div>
            <div class="pss-support-issue-row">
              <span class="pss-open-icon">◉</span><div><strong>{{ t('priority-support-story-google-issue-title') }}</strong><p>#417 {{ t('priority-support-story-opened-yesterday-by-jules') }}</p></div><aside><em class="bug">{{ t('priority-support-story-bug') }}</em></aside>
            </div>
            <div class="pss-support-issue-row">
              <span class="pss-open-icon">◉</span><div><strong>{{ t('priority-support-story-redirect-issue-title') }}</strong><p>#414 {{ t('priority-support-story-opened-last-week-by-native-labs') }}</p></div><aside><em>{{ t('priority-support-story-documentation') }}</em></aside>
            </div>
          </div>

          <div class="pss-support-issue">
            <div class="pss-repo-tabs">
              <span>{{ t('priority-support-story-code') }}</span><span class="selected">{{ t('priority-support-story-issues') }} <b class="pss-support-issues-count">13</b></span><span>{{ t('priority-support-story-pull-requests') }} <b>2</b></span><span>{{ t('priority-support-story-actions') }}</span>
            </div>
            <div class="pss-issue-title">
              <h3>{{ t('priority-support-story-microsoft-title') }} <span>#418</span></h3><div><span class="pss-issue-status-slot"><em class="pss-open-pill">{{ t('priority-support-story-open') }}</em><em class="pss-closed-pill">✓ {{ t('priority-support-story-closed') }}</em></span><span>{{ t('priority-support-story-opened-issue-now') }}</span></div>
            </div>
            <div class="pss-comment-row pss-support-context-row pss-pinned-issue-context">
              <div class="pss-avatar pss-avatar-user">
                AM
              </div><div class="pss-comment-card">
                <header><b>acme-mobile</b><span>{{ t('priority-support-story-commented-now') }}</span><i>{{ t('priority-support-story-author') }}</i></header><p>{{ t('priority-support-story-microsoft-body') }}</p>
              </div>
            </div>
            <div class="pss-support-thread-viewport">
              <div class="pss-support-thread-track">
                <div class="pss-comment-row pss-support-context-row">
                  <div class="pss-avatar pss-avatar-bot">
                    ✦
                  </div><div class="pss-comment-card pss-bot-card">
                    <header><b>capgo-bot</b><i>{{ t('priority-support-story-bot') }}</i><span>{{ t('priority-support-story-commented-now') }}</span></header><p>{{ t('priority-support-story-bot-reply') }}</p>
                  </div>
                </div>
                <div class="pss-issue-event pss-support-priority-event">
                  <span>⚡</span><p>{{ t('priority-support-story-priority-assigned-event') }}</p>
                </div>
                <div class="pss-issue-event pss-merged-event">
                  <span>⑂</span><p>{{ t('priority-support-story-linked-merged-pr') }}</p>
                </div>
                <div class="pss-comment-row pss-support-reply">
                  <div class="pss-avatar pss-avatar-capgo">
                    CG
                  </div><div class="pss-reply-stack">
                    <div class="pss-comment-card pss-reply-composer">
                      <header><b>{{ t('priority-support-story-write') }}</b><span>{{ t('priority-support-story-preview') }}</span></header>
                      <p><span class="pss-reply-draft" /><i class="pss-typing-caret pss-reply-caret" /></p>
                      <footer>
                        <span>{{ t('priority-support-story-attach-files') }}</span><span class="pss-close-button">
                          {{ t('priority-support-story-comment-close') }}
                        </span>
                      </footer>
                    </div>
                    <div class="pss-comment-card pss-posted-reply">
                      <header><b>capgo-support</b><span>{{ t('priority-support-story-commented-now') }}</span><i>{{ t('priority-support-story-member') }}</i></header><p>{{ t('priority-support-story-maintainer-reply') }}</p>
                    </div>
                  </div>
                </div>
                <div class="pss-issue-event pss-closed-event">
                  <span>✓</span><p>{{ t('priority-support-story-closed-completed') }}</p>
                </div>
                <div class="pss-comment-row pss-thanks-comment">
                  <div class="pss-avatar pss-avatar-user">
                    AM
                  </div><div class="pss-comment-card pss-thanks-card">
                    <header><b>acme-mobile</b><span>{{ t('priority-support-story-commented-now') }}</span><i>{{ t('priority-support-story-author') }}</i></header><p>{{ t('priority-support-story-thanks') }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="pss-dock pss-support-dock">
          <span class="pss-dock-icon pss-mail-app pss-support-mail-icon"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="6" y="8" width="52" height="46" rx="12" fill="#168cf5" /><path d="m11 16 21 17 21-17" fill="none" stroke="#fff" stroke-width="4" /><path d="m11 49 16-15m26 15L37 34" fill="none" stroke="#dff2ff" stroke-width="3" /></svg><i /></span>
          <span class="pss-dock-icon pss-vscode pss-support-code-icon"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M44 5 58 11v42l-14 6-25-22-10 8-6-5 13-12L3 16l6-5 10 8z" fill="#168cf5" /><path d="M44 18 27 32l17 14z" fill="#fff" opacity=".92" /></svg><i /></span>
          <span class="pss-dock-icon pss-safari pss-support-browser-icon"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="#fff" /><circle cx="32" cy="32" r="23" fill="#2ca7ef" /><path d="m38 20-4 14-8 10 4-14z" fill="#f43f5e" /><path d="m26 44 4-14 8-10-4 14z" fill="#fff" /><circle cx="32" cy="32" r="3" fill="#172554" /></svg><i /></span>
          <span class="pss-dock-divider" />
          <span class="pss-dock-icon pss-trash"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M17 18h30l-3 37H20z" fill="#cbd5e1" /><path d="M13 14h38M25 10h14" stroke="#fff" stroke-width="4" /><path d="m26 25 1 21m10-21-1 21" stroke="#64748b" stroke-width="3" /></svg></span>
        </div>
      </div>
    </section>

    <div class="pss-pointer" aria-hidden="true">
      <span class="pss-pointer-ring" />
      <svg viewBox="0 0 28 34"><path d="M3 2.5v23.1l6.3-5.9 4.4 10.5 4.1-1.9-4.4-10.1h9.2z" fill="#fff" stroke="#111827" stroke-width="2" stroke-linejoin="round" /></svg>
    </div>
  </div>
</template>

<style scoped>
.pss-story {
  position: relative;
  z-index: 1;
  isolation: isolate;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  overflow: clip;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 17px;
  clip-path: inset(0 round 17px);
  background: #07111f;
  box-shadow: 0 18px 45px rgba(4, 12, 28, 0.34);
  container-type: inline-size;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.pss-story.is-replayable {
  cursor: pointer;
}
.pss-story.is-replayable:focus-visible {
  outline: 3px solid #38bdf8;
  outline-offset: -5px;
}
.pss-example-label {
  position: absolute;
  right: 10px;
  bottom: 7px;
  z-index: 30;
  color: rgba(255, 255, 255, 0.58);
  font-size: 8px;
  font-weight: 650;
  letter-spacing: 0.04em;
  pointer-events: none;
}
.pss-example-label.is-replay {
  color: rgba(255, 255, 255, 0.82);
}
.pss-example-label.is-replay span {
  display: inline-block;
  margin-right: 2px;
  font-size: 10px;
}
.pss-machine,
.pss-desktop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  overflow: clip;
  border-radius: 16px;
  clip-path: inset(0 round 16px);
}
.pss-support-machine {
  opacity: 0;
  visibility: hidden;
}
.pss-user-browser {
  opacity: 0;
  visibility: hidden;
}
.pss-user-desktop {
  background:
    radial-gradient(circle at 24% 18%, rgba(91, 146, 255, 0.92), transparent 32%),
    radial-gradient(circle at 76% 70%, rgba(103, 65, 217, 0.92), transparent 38%),
    linear-gradient(145deg, #15356b, #261f5f 58%, #131f3b);
}
.pss-support-desktop {
  background:
    radial-gradient(circle at 26% 22%, rgba(43, 154, 255, 0.82), transparent 30%),
    radial-gradient(circle at 72% 66%, rgba(58, 73, 170, 0.72), transparent 38%),
    linear-gradient(145deg, #123763, #18285a 52%, #101b39);
}
.pss-menu-bar {
  position: absolute;
  inset: 0 0 auto;
  z-index: 2;
  display: flex;
  height: 21px;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-radius: 16px 16px 0 0;
  background: rgba(5, 13, 28, 0.42);
  backdrop-filter: blur(14px);
  color: rgba(255, 255, 255, 0.88);
  font-size: 8px;
}
.pss-menu-bar > b {
  font-size: 7px;
}
.pss-menu-bar strong {
  font-size: 8px;
}
.pss-menu-bar i {
  margin-left: auto;
  font-style: normal;
}
.pss-window {
  position: absolute;
  z-index: 5;
  overflow: hidden;
  overflow: clip;
  isolation: isolate;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 10px;
  box-shadow: 0 20px 46px rgba(0, 0, 0, 0.48);
  clip-path: inset(0 round 10px);
}
.pss-browser-window {
  inset: 31px 16px 62px;
  background: #0d1117;
}
.pss-browser-chrome,
.pss-mac-titlebar {
  display: flex;
  height: 27px;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid #30363d;
  border-radius: 9px 9px 0 0;
  background: #1b2028;
}
.pss-traffic {
  display: flex;
  gap: 5px;
  align-items: center;
}
.pss-traffic i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ff5f57;
}
.pss-traffic i:nth-child(2) {
  background: #febc2e;
}
.pss-traffic i:nth-child(3) {
  background: #28c840;
}
.pss-browser-actions {
  display: flex;
  gap: 7px;
  color: #8b949e;
  font-size: 14px;
}
.pss-address {
  min-width: 0;
  flex: 1;
  border-radius: 5px;
  padding: 4px 9px;
  background: #11161d;
  color: #a9b4c2;
  font-size: 8px;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pss-github-global {
  display: flex;
  height: 31px;
  align-items: center;
  gap: 8px;
  padding: 0 11px;
  border-bottom: 1px solid #30363d;
  background: #010409;
  font-size: 8px;
}
.pss-github-global > svg {
  width: 17px;
  height: 17px;
}
.pss-github-global > b {
  display: grid;
  width: 19px;
  height: 19px;
  margin-left: auto;
  place-items: center;
  border-radius: 50%;
  background: #31527a;
  font-size: 7px;
}
.pss-gh-search {
  width: 150px;
  border: 1px solid #30363d;
  border-radius: 5px;
  padding: 4px 7px;
  color: #8b949e;
}
.pss-gh-search kbd {
  float: right;
}
.pss-repo-line {
  display: flex;
  height: 36px;
  align-items: center;
  gap: 6px;
  padding: 0 13px;
  color: #8b949e;
  font-size: 9px;
}
.pss-repo-line svg {
  width: 14px;
}
.pss-repo-line strong,
.pss-repo-line span {
  color: #58a6ff;
}
.pss-repo-line em {
  border: 1px solid #30363d;
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 7px;
  font-style: normal;
}
.pss-repo-tabs,
.pss-pr-tabs {
  display: flex;
  min-height: 29px;
  align-items: flex-end;
  gap: 16px;
  padding: 0 13px;
  border-bottom: 1px solid #30363d;
  color: #8b949e;
  font-size: 8px;
}
.pss-repo-tabs > span {
  padding: 8px 0 6px;
  white-space: nowrap;
}
.pss-repo-tabs .selected {
  border-bottom: 2px solid #f78166;
  color: #e6edf3;
  font-weight: 700;
}
.pss-repo-tabs b {
  border-radius: 999px;
  padding: 1px 4px;
  background: #30363d;
  font-size: 7px;
}
.pss-github-page,
.pss-pr-view,
.pss-support-issue {
  position: absolute;
  inset: 123px 0 0;
  background: #0d1117;
}
.pss-create-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px 7px;
}
.pss-create-heading h3 {
  margin: 0;
  font-size: 14px;
}
.pss-create-heading span {
  border: 1px solid #30363d;
  border-radius: 5px;
  padding: 4px 7px;
  color: #8b949e;
  font-size: 7px;
}
.pss-composer-grid {
  display: grid;
  grid-template-columns: 25px minmax(0, 1fr) 78px;
  gap: 8px;
  padding: 3px 14px 10px;
}
.pss-avatar {
  display: grid;
  width: 25px;
  height: 25px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  font-size: 7px;
  font-weight: 800;
}
.pss-avatar-user {
  background: linear-gradient(145deg, #2563eb, #7c3aed);
}
.pss-avatar-bot {
  background: linear-gradient(145deg, #159eff, #0c5fa8);
  font-size: 11px;
}
.pss-avatar-capgo {
  background: linear-gradient(145deg, #119eff, #075ea3);
}
.pss-compose-card {
  min-width: 0;
  position: relative;
  border: 1px solid #30363d;
  border-radius: 7px;
  background: #0d1117;
}
.pss-compose-card label {
  display: block;
  padding: 6px 8px 3px;
  color: #8b949e;
  font-size: 7px;
}
.pss-title-input {
  min-height: 29px;
  margin: 0 7px 7px;
  border: 1px solid #30363d;
  border-radius: 5px;
  padding: 6px 7px;
  background: #010409;
  color: #e6edf3;
  font-size: 10px;
  font-weight: 600;
}
.pss-composer-tabs {
  display: flex;
  height: 24px;
  align-items: end;
  gap: 14px;
  border-bottom: 1px solid #30363d;
  padding: 0 8px;
  color: #8b949e;
  font-size: 7px;
}
.pss-composer-tabs b {
  border: 1px solid #30363d;
  border-bottom-color: #0d1117;
  border-radius: 5px 5px 0 0;
  padding: 5px 8px;
  color: #e6edf3;
  transform: translateY(1px);
}
.pss-markdown-tools {
  display: flex;
  gap: 10px;
  padding: 6px 9px;
  color: #8b949e;
  font-size: 8px;
}
.pss-body-input {
  min-height: 43px;
  margin: 0 7px 7px;
  border: 1px solid #30363d;
  border-radius: 5px;
  padding: 7px 8px;
  background: #010409;
  color: #c9d1d9;
  font-size: 9px;
  line-height: 1.35;
}
.pss-typing-caret {
  display: inline-block;
  width: 1px;
  height: 1.05em;
  margin-left: 1px;
  background: #e6edf3;
  vertical-align: -0.12em;
  animation: pss-caret 0.62s step-end infinite;
}
.pss-submit-issue,
.pss-merge-button,
.pss-confirm-button {
  display: inline-block;
  float: right;
  margin: 0 7px 7px;
  border: 1px solid rgba(240, 246, 252, 0.1);
  border-radius: 6px;
  padding: 6px 10px;
  background: #238636;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
}
.pss-issue-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #8b949e;
  font-size: 7px;
}
.pss-issue-meta b {
  margin-top: 3px;
  color: #c9d1d9;
}
.pss-issue-meta em,
.pss-issue-sidebar em {
  align-self: flex-start;
  border-radius: 999px;
  padding: 2px 5px;
  background: #6f42c1;
  color: #fff;
  font-style: normal;
}
.pss-created-issue {
  padding: 0 14px 10px;
}
.pss-issue-title {
  padding: 10px 0 8px;
  border-bottom: 1px solid #30363d;
}
.pss-issue-title h3 {
  margin: 0 0 6px;
  color: #e6edf3;
  font-size: 14px;
  line-height: 1.2;
}
.pss-issue-title h3 span {
  color: #8b949e;
  font-weight: 400;
}
.pss-issue-title > div {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #8b949e;
  font-size: 7px;
}
.pss-issue-title em,
.pss-pr-heading em {
  border-radius: 999px;
  padding: 4px 8px;
  background: #238636;
  color: #fff;
  font-style: normal;
  font-weight: 700;
}
.pss-issue-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px;
  gap: 14px;
  padding-top: 9px;
}
.pss-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pss-comment-row {
  display: flex;
  gap: 8px;
  position: relative;
}
.pss-comment-row::before {
  content: '';
  position: absolute;
  z-index: 0;
  top: 24px;
  bottom: -11px;
  left: 12px;
  width: 1px;
  background: #30363d;
}
.pss-comment-row:last-child::before {
  display: none;
}
.pss-comment-card {
  z-index: 1;
  min-width: 0;
  flex: 1;
  border: 1px solid #30363d;
  border-radius: 7px;
  background: #0d1117;
}
.pss-comment-card header {
  display: flex;
  min-height: 25px;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border-bottom: 1px solid #30363d;
  background: #161b22;
  color: #8b949e;
  font-size: 8px;
}
.pss-comment-card header b {
  color: #e6edf3;
}
.pss-comment-card header i {
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 1px 4px;
  font-style: normal;
}
.pss-comment-card p {
  margin: 0;
  padding: 8px;
  color: #c9d1d9;
  font-size: 9px;
  line-height: 1.35;
}
.pss-bot-card {
  border-color: rgba(17, 158, 255, 0.56);
}
.pss-bot-card header {
  background: rgba(17, 158, 255, 0.1);
}
.pss-priority-label {
  display: table;
  margin: 0 8px 7px;
  border-radius: 999px;
  padding: 2px 6px;
  background: #0b5cad;
  color: #cce8ff;
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
}
.pss-issue-sidebar {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: #8b949e;
  font-size: 7px;
}
.pss-issue-sidebar b {
  border-bottom: 1px solid #30363d;
  padding-bottom: 4px;
  color: #c9d1d9;
}
.pss-dock {
  position: absolute;
  z-index: 20;
  bottom: 8px;
  left: 50%;
  display: flex;
  height: 46px;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 17px;
  padding: 5px 8px;
  background: rgba(255, 255, 255, 0.09);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(15px) saturate(1.3);
  transform: translateX(-50%);
}
.pss-dock-icon {
  position: relative;
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  transform-origin: 50% 100%;
}
.pss-dock-icon > svg {
  width: 32px;
  height: 32px;
  filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.25));
}
.pss-dock-icon > i {
  position: absolute;
  bottom: -5px;
  left: 50%;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #fff;
  transform: translateX(-50%);
}
.pss-files {
  background: linear-gradient(#e9f6ff, #6ab4ef);
}
.pss-support-dock {
  gap: 7px;
}
.pss-dock-divider {
  width: 1px;
  height: 28px;
  background: rgba(255, 255, 255, 0.24);
}
.pss-priority-notification {
  position: absolute;
  z-index: 25;
  top: 30px;
  right: 10px;
  display: flex;
  width: 238px;
  gap: 9px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 13px;
  padding: 10px;
  background: rgba(230, 239, 251, 0.87);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.26);
  backdrop-filter: blur(18px);
  color: #101827;
}
.pss-mail-app-icon {
  width: 32px;
  height: 32px;
  flex: none;
}
.pss-mail-app-icon svg {
  width: 100%;
}
.pss-notification > div:last-child {
  min-width: 0;
  flex: 1;
}
.pss-notification header {
  display: flex;
  justify-content: space-between;
  color: #5b6473;
  font-size: 8px;
}
.pss-notification header b {
  color: #1c2636;
}
.pss-notification strong {
  display: block;
  margin-top: 2px;
  font-size: 10px;
}
.pss-notification p {
  margin: 2px 0 0;
  color: #4b5565;
  font-size: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pss-mail-window,
.pss-code-window,
.pss-support-browser {
  inset: 30px 14px 61px;
}
.pss-mail-window {
  background: #edf1f7;
  color: #202838;
}
.pss-mac-titlebar {
  justify-content: space-between;
  border-color: #c5ccd7;
  background: rgba(246, 248, 251, 0.96);
}
.pss-mac-titlebar strong {
  position: absolute;
  left: 50%;
  font-size: 9px;
  transform: translateX(-50%);
}
.pss-mail-layout {
  display: grid;
  height: calc(100% - 27px);
  grid-template-columns: 93px 142px minmax(0, 1fr);
}
.pss-mailboxes {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 8px;
  border-right: 1px solid #cbd3df;
  background: rgba(220, 228, 239, 0.94);
  color: #566276;
  font-size: 8px;
}
.pss-mailboxes b {
  margin-top: 3px;
  color: #778397;
  font-size: 7px;
  text-transform: uppercase;
}
.pss-mailboxes .selected {
  border-radius: 5px;
  padding: 5px 6px;
  background: #168cf5;
  color: #fff;
}
.pss-mailboxes i {
  float: right;
  font-style: normal;
}
.pss-message-list {
  border-right: 1px solid #cbd3df;
  background: #f7f9fc;
}
.pss-message-list > header {
  height: 30px;
  padding: 9px;
  border-bottom: 1px solid #d8dee8;
  font-size: 9px;
  font-weight: 700;
}
.pss-message-list > div {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px;
  padding: 8px;
  border-bottom: 1px solid #d8dee8;
  font-size: 7px;
}
.pss-message-list > div.selected {
  background: #168cf5;
  color: #fff;
}
.pss-message-list strong,
.pss-message-list p {
  grid-column: 1 / -1;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pss-message-list time {
  font-size: 6px;
}
.pss-mail-reading {
  padding: 12px 14px;
  background: #fff;
  overflow: hidden;
}
.pss-mail-reading > header {
  border-bottom: 1px solid #dde3eb;
  padding-bottom: 8px;
}
.pss-mail-reading h3 {
  margin: 0 0 4px;
  font-size: 13px;
}
.pss-mail-reading header span {
  color: #6b7280;
  font-size: 8px;
}
.pss-email-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 11px;
}
.pss-email-brand b {
  color: #087eca;
  font-size: 12px;
}
.pss-email-brand em {
  border-radius: 999px;
  padding: 3px 6px;
  background: #e5f4ff;
  color: #087eca;
  font-size: 6px;
  font-style: normal;
  font-weight: 800;
}
.pss-mail-account {
  border-radius: 5px;
  padding: 5px 7px;
  background: #edf7ff;
  color: #087eca !important;
  font-weight: 700;
}
.pss-mail-reading h4 {
  margin: 9px 0 4px;
  font-size: 11px;
}
.pss-mail-reading p {
  margin: 4px 0;
  color: #566276;
  font-size: 9px;
  line-height: 1.4;
}
.pss-open-github {
  display: inline-block;
  margin-top: 7px;
  border: 0;
  border-radius: 5px;
  padding: 5px 9px;
  background: #168cf5;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
}
.pss-code-window {
  background: #181818;
  color: #cccccc;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.pss-code-titlebar {
  display: grid;
  height: 27px;
  grid-template-columns: 70px 1fr 70px;
  align-items: center;
  padding: 0 8px;
  border-radius: 9px 9px 0 0;
  background: #181818;
  color: #a8a8a8;
  font-size: 7px;
}
.pss-code-titlebar div {
  border: 1px solid #3b3b3b;
  border-radius: 6px;
  padding: 4px;
  text-align: center;
}
.pss-code-titlebar i {
  text-align: right;
  font-style: normal;
}
.pss-vscode-layout {
  display: grid;
  height: calc(100% - 44px);
  grid-template-columns: 35px 118px minmax(0, 1fr);
  border-top: 1px solid #2b2b2b;
}
.pss-activity-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
  padding-top: 10px;
  background: #181818;
}
.pss-activity-bar svg {
  width: 16px;
  fill: none;
  stroke: #8d8d8d;
  stroke-width: 1.6;
}
.pss-activity-bar svg:first-child {
  stroke: #fff;
}
.pss-explorer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 6px;
  background: #1f1f1f;
  font-size: 7px;
  overflow: hidden;
}
.pss-explorer header {
  display: flex;
  justify-content: space-between;
  color: #bbbbbb;
  font-size: 7px;
}
.pss-explorer strong {
  margin: 4px 0 2px;
  color: #ddd;
  font-size: 7px;
}
.pss-explorer span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pss-explorer .indent {
  padding-left: 8px;
}
.pss-explorer .indent2 {
  padding-left: 17px;
}
.pss-explorer .active {
  margin: 0 -6px;
  padding-top: 3px;
  padding-bottom: 3px;
  padding-left: 23px;
  background: #37373d;
  color: #fff;
}
.pss-editor {
  min-width: 0;
  display: grid;
  grid-template-rows: 27px 20px minmax(0, 1fr) 61px;
  background: #1e1e1e;
}
.pss-code-tabs {
  display: flex;
  background: #181818;
  color: #969696;
  font-size: 7px;
  overflow: hidden;
}
.pss-code-tabs span {
  padding: 8px 10px;
  background: #2d2d2d;
  white-space: nowrap;
}
.pss-code-tabs .active {
  border-top: 1px solid #119eff;
  background: #1e1e1e;
  color: #fff;
}
.pss-code-tabs i {
  margin-left: 7px;
  font-style: normal;
}
.pss-breadcrumbs {
  padding: 5px 10px;
  color: #9d9d9d;
  font-size: 7px;
}
.pss-editor-canvas {
  position: relative;
  display: flex;
  min-height: 0;
  overflow: hidden;
  padding-top: 7px;
}
.pss-line-numbers {
  width: 30px;
  flex: none;
  color: #858585;
  font-size: 7px;
  line-height: 15px;
  text-align: right;
}
.pss-code-skeleton {
  display: flex;
  width: 72%;
  flex-direction: column;
  gap: 9px;
  padding: 3px 0 0 13px;
}
.pss-code-skeleton i {
  width: 52%;
  height: 4px;
  border-radius: 3px;
  background: linear-gradient(90deg, #569cd6 0 18%, #ce9178 18% 54%, #9cdcfe 54%);
  opacity: 0.66;
}
.pss-code-skeleton i.wide {
  width: 87%;
}
.pss-code-skeleton i.medium {
  width: 68%;
}
.pss-code-skeleton i.short {
  width: 34%;
}
.pss-matrix {
  position: absolute;
  z-index: 3;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #030c09;
}
.pss-code-status {
  position: absolute;
  z-index: 5;
  top: 50%;
  left: 50%;
  display: flex;
  width: max-content;
  max-width: 90%;
  align-items: center;
  gap: 10px;
  border: 1px solid #4a4a4a;
  border-radius: 8px;
  padding: 10px 14px;
  background: rgba(24, 24, 24, 0.94);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.44);
  color: #f3f4f6;
  font-size: 13px;
  font-weight: 650;
}
.pss-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid #555;
  border-top-color: #119eff;
  border-radius: 50%;
  animation: pss-spin 0.8s linear infinite;
}
.pss-terminal-caret {
  color: #4ade80;
  font-weight: 800;
}
.pss-pr-icon {
  color: #c084fc;
  font-size: 15px;
}
.pss-panel {
  border-top: 1px solid #3c3c3c;
  background: #181818;
}
.pss-panel header {
  display: flex;
  gap: 13px;
  padding: 7px 10px;
  color: #aaa;
  font-size: 6px;
}
.pss-panel b {
  border-bottom: 1px solid #119eff;
  padding-bottom: 4px;
  color: #fff;
}
.pss-panel p {
  margin: 2px 10px;
  color: #aaa;
  font-size: 7px;
}
.pss-panel p i {
  color: #22c55e;
  font-style: normal;
}
.pss-status-bar {
  display: flex;
  height: 17px;
  align-items: center;
  gap: 12px;
  padding: 0 7px;
  background: #007acc;
  color: #fff;
  font-size: 6px;
}
.pss-status-bar i {
  margin-left: auto;
  font-style: normal;
}
.pss-support-browser .pss-repo-line {
  height: 33px;
}
.pss-support-browser .pss-pr-view,
.pss-support-browser .pss-support-issue {
  inset: 91px 0 0;
}
.pss-pr-heading {
  padding: 10px 13px 8px;
}
.pss-pr-heading h3 {
  margin: 0 0 7px;
  font-size: 15px;
}
.pss-pr-heading h3 span {
  color: #8b949e;
  font-weight: 400;
}
.pss-pr-heading > div {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #8b949e;
  font-size: 8px;
}
.pss-pr-tabs {
  align-items: center;
  min-height: 27px;
  font-size: 8px;
}
.pss-pr-tabs b {
  height: 27px;
  border-bottom: 2px solid #f78166;
  padding-top: 8px;
  color: #e6edf3;
}
.pss-pr-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 190px;
  gap: 12px;
  padding: 10px 13px;
}
.pss-pr-summary {
  display: flex;
  gap: 8px;
}
.pss-pr-summary > div:last-child {
  flex: 1;
  border: 1px solid #30363d;
  border-radius: 7px;
  padding: 8px;
  font-size: 8px;
}
.pss-pr-summary span {
  margin-left: 5px;
  color: #8b949e;
}
.pss-pr-summary p {
  margin: 7px 0 0;
  color: #c9d1d9;
  font-size: 9px;
}
.pss-merge-box {
  position: relative;
  min-height: 130px;
  border: 1px solid #238636;
  border-radius: 7px;
  padding: 9px;
  background: rgba(35, 134, 54, 0.06);
}
.pss-merge-box > header {
  display: flex;
  gap: 7px;
}
.pss-merge-box > header > span {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: #238636;
  color: #fff;
  font-size: 8px;
}
.pss-merge-box header div {
  display: grid;
  gap: 2px;
}
.pss-merge-box header b {
  font-size: 9px;
}
.pss-merge-box header small {
  color: #8b949e;
  font-size: 8px;
}
.pss-merge-box > p {
  color: #8b949e;
  font-size: 8px;
}
.pss-merge-box > p span {
  color: #3fb950;
}
.pss-merge-box .pss-merge-button {
  float: none;
  margin: 4px 0 0;
}
.pss-merge-box .pss-merge-button,
.pss-confirm-merge .pss-confirm-button {
  border-color: #46c35f;
  background: linear-gradient(180deg, #31a94f, #238636);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 0 0 1px rgba(46, 160, 67, 0.18),
    0 5px 13px rgba(35, 134, 54, 0.28);
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.26);
}
.pss-confirm-merge {
  position: absolute;
  z-index: 4;
  inset: 38px 8px 8px;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px;
  background: #161b22;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.38);
}
.pss-confirm-merge b,
.pss-confirm-merge span {
  display: block;
  font-size: 9px;
}
.pss-confirm-merge span {
  margin-top: 4px;
  color: #8b949e;
  font-size: 8px;
}
.pss-confirm-button {
  float: none;
  margin: 9px 0 0;
}
.pss-merged-state {
  position: absolute;
  inset: 45px 10px auto;
  display: grid;
  gap: 5px;
  border-radius: 6px;
  padding: 10px;
  background: rgba(130, 80, 223, 0.18);
  text-align: center;
}
.pss-merged-state b {
  color: #d2a8ff;
  font-size: 11px;
}
.pss-merged-state span {
  color: #8b949e;
  font-size: 8px;
}
.pss-support-issue {
  padding: 0 13px;
}
.pss-support-issue .pss-issue-title {
  padding-top: 9px;
}
.pss-open-pill,
.pss-closed-pill {
  display: inline-block;
}
.pss-closed-pill {
  position: absolute;
  left: 0;
  background: #8250df !important;
}
.pss-resolution-timeline {
  display: grid;
  gap: 9px;
  max-width: 92%;
  padding-top: 10px;
}
.pss-reply-stack {
  position: relative;
  min-height: 101px;
  flex: 1;
}
.pss-reply-stack > .pss-comment-card {
  position: absolute;
  inset: 0;
}
.pss-reply-composer {
  border-color: #8b949e;
}
.pss-reply-composer header {
  gap: 14px;
}
.pss-reply-composer header b {
  border-bottom: 2px solid #f78166;
  padding: 7px 2px 5px;
}
.pss-reply-composer p {
  min-height: 42px;
  margin: 6px;
  border: 1px solid #30363d;
  border-radius: 5px;
  padding: 7px;
  background: #010409;
  overflow: hidden;
}
.pss-reply-composer footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 6px;
  color: #8b949e;
  font-size: 7px;
}
.pss-close-button {
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 6px 10px;
  background: #21262d;
  color: #e6edf3;
  font-size: 9px;
  font-weight: 700;
}
.pss-thanks-card {
  border-color: rgba(17, 158, 255, 0.55);
}
.pss-thanks-card header {
  background: rgba(17, 158, 255, 0.09);
}

/* GitHub states deliberately share geometry so transitions never jump. */
.pss-issue-event {
  position: relative;
  display: flex;
  min-height: 24px;
  align-items: center;
  gap: 7px;
  margin-left: 33px;
  color: #8b949e;
  font-size: 7px;
}
.pss-issue-event::before {
  content: '';
  position: absolute;
  top: -10px;
  bottom: -7px;
  left: 11px;
  width: 1px;
  background: #30363d;
}
.pss-issue-event > span {
  z-index: 1;
  display: grid;
  width: 23px;
  height: 23px;
  flex: none;
  place-items: center;
  border: 1px solid #30363d;
  border-radius: 50%;
  background: #0d1117;
  color: #58a6ff;
  font-size: 10px;
}
.pss-issue-event p {
  margin: 0;
}
.pss-issue-event em {
  border-radius: 999px;
  padding: 2px 5px;
  background: #0b5cad;
  color: #cce8ff;
  font-style: normal;
  font-weight: 700;
}
.pss-created-entitlement {
  will-change: transform, opacity;
}

.pss-support-browser .pss-pr-view,
.pss-support-browser .pss-support-issues-list,
.pss-support-browser .pss-support-issue {
  inset: 91px 0 0;
  min-height: 0;
  overflow: hidden;
}
.pss-support-issues-list {
  position: absolute;
  background: #0d1117;
}
.pss-support-issues-tab,
.pss-priority-issue-row {
  cursor: pointer;
}
.pss-pr-status-slot,
.pss-pr-meta-slot,
.pss-issue-status-slot {
  display: inline-grid;
  flex: none;
  align-items: center;
}
.pss-pr-status-slot > *,
.pss-pr-meta-slot > *,
.pss-issue-status-slot > * {
  grid-area: 1 / 1;
}
.pss-pr-meta-slot {
  min-width: 0;
  flex: 1;
}
.pss-pr-meta-slot > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pss-pr-merged-pill,
.pss-closed-pill {
  background: #8250df !important;
}
.pss-pr-summary small {
  display: block;
  margin-top: 8px;
  color: #58a6ff;
  font-size: 8px;
}
.pss-merge-box {
  min-height: 130px;
  overflow: hidden;
}
.pss-merge-state {
  position: absolute;
  inset: 9px;
}
.pss-merge-ready > header {
  display: flex;
  gap: 7px;
}
.pss-merge-ready > header > span {
  display: grid;
  width: 18px;
  height: 18px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: #238636;
  color: #fff;
  font-size: 8px;
}
.pss-merge-ready header div {
  display: grid;
  gap: 2px;
}
.pss-merge-ready header b {
  font-size: 9px;
}
.pss-merge-ready header small {
  color: #8b949e;
  font-size: 8px;
}
.pss-merge-ready > p {
  color: #8b949e;
  font-size: 8px;
}
.pss-merge-ready > p span {
  color: #3fb950;
}
.pss-confirm-merge {
  display: flex;
  flex-direction: column;
  justify-content: center;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px;
  background: #161b22;
  box-shadow: none;
}
.pss-confirm-merge code {
  border-radius: 3px;
  padding: 1px 3px;
  background: #30363d;
  color: #e6edf3;
}
.pss-merged-state {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 6px;
  padding: 11px;
  background: rgba(130, 80, 223, 0.14);
  text-align: left;
}
.pss-merged-state .pss-merged-icon {
  display: grid;
  width: 25px;
  height: 25px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: #8250df;
  color: #fff;
  font-weight: 800;
}
.pss-merged-state div {
  display: grid;
  gap: 4px;
}
.pss-merged-state b {
  color: #d2a8ff;
  font-size: 9px;
}
.pss-merged-state span {
  color: #8b949e;
  font-size: 7px;
}

.pss-issues-toolbar {
  display: flex;
  height: 46px;
  align-items: center;
  justify-content: space-between;
  margin: 8px 12px 0;
  border: 1px solid #30363d;
  border-radius: 7px 7px 0 0;
  padding: 0 9px;
  background: #161b22;
  color: #8b949e;
  font-size: 8px;
}
.pss-issues-toolbar div {
  display: flex;
  gap: 12px;
}
.pss-issues-toolbar b {
  color: #e6edf3;
}
.pss-list-new-issue {
  display: inline-block;
  border: 1px solid rgba(240, 246, 252, 0.1);
  border-radius: 6px;
  padding: 6px 10px;
  background: #238636;
  color: #fff;
  font-size: 8px;
  font-weight: 700;
}
.pss-issues-list-head {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin: 0 12px;
  border: 1px solid #30363d;
  border-top: 0;
  padding: 6px 9px;
  color: #8b949e;
  font-size: 7px;
}
.pss-support-issue-row {
  display: grid;
  min-height: 49px;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: start;
  gap: 5px;
  margin: 0 12px;
  border: 1px solid #30363d;
  border-top: 0;
  padding: 8px 9px;
  background: #0d1117;
}
.pss-support-issue-row:last-child {
  border-radius: 0 0 7px 7px;
}
.pss-support-issue-row:hover,
.pss-priority-issue-row {
  background: #101822;
}
.pss-open-icon {
  color: #3fb950;
  font-size: 11px;
}
.pss-support-issue-row strong {
  display: block;
  overflow: hidden;
  color: #e6edf3;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pss-priority-issue-row strong {
  color: #58a6ff;
}
.pss-support-issue-row p {
  margin: 3px 0 0;
  color: #8b949e;
  font-size: 7px;
}
.pss-support-issue-row aside {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pss-support-issue-row aside em {
  border-radius: 999px;
  padding: 2px 5px;
  background: #6e40c9;
  color: #fff;
  font-size: 6px;
  font-style: normal;
  font-weight: 700;
}
.pss-support-issue-row aside .priority {
  background: #0b5cad;
}
.pss-support-issue-row aside .bug {
  background: #b62324;
}
.pss-support-issue-row aside b {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 50%;
  background: #075ea3;
  color: #fff;
  font-size: 6px;
}

.pss-support-issue {
  display: flex;
  flex-direction: column;
  padding: 0;
}
.pss-support-issue > .pss-repo-tabs {
  flex: none;
}
.pss-support-issue .pss-issue-title {
  flex: none;
  margin: 0 13px;
  padding: 8px 0 7px;
}
.pss-support-issue .pss-issue-title h3 {
  margin-bottom: 5px;
  font-size: 13px;
}
.pss-issue-status-slot {
  min-width: 44px;
}
.pss-open-pill,
.pss-closed-pill {
  position: relative;
  left: auto;
  display: inline-block;
  width: max-content;
}
.pss-support-thread-viewport {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: 7px 13px 0;
}
.pss-pinned-issue-context {
  flex: none;
  gap: 7px;
  margin: 7px 13px 0;
}
.pss-pinned-issue-context::before {
  display: none;
}
.pss-pinned-issue-context .pss-avatar {
  width: 22px;
  height: 22px;
  font-size: 6px;
}
.pss-pinned-issue-context .pss-comment-card header {
  min-height: 21px;
  padding: 0 7px;
  font-size: 7px;
}
.pss-pinned-issue-context .pss-comment-card p {
  padding: 6px 7px;
  font-size: 7.5px;
  line-height: 1.28;
}
.pss-support-thread-track {
  display: grid;
  gap: 6px;
  will-change: transform;
}
.pss-support-context-row .pss-avatar,
.pss-support-reply .pss-avatar,
.pss-thanks-comment .pss-avatar {
  width: 22px;
  height: 22px;
  font-size: 6px;
}
.pss-support-thread-track .pss-comment-row {
  gap: 7px;
}
.pss-support-thread-track .pss-comment-row::before {
  top: 21px;
  left: 10px;
  bottom: -8px;
}
.pss-support-thread-track .pss-comment-card header {
  min-height: 21px;
  padding: 0 7px;
  font-size: 7px;
}
.pss-support-thread-track .pss-comment-card p {
  padding: 6px 7px;
  font-size: 7.5px;
  line-height: 1.28;
}
.pss-support-thread-track .pss-issue-event {
  min-height: 21px;
  margin-left: 29px;
}
.pss-support-thread-track .pss-issue-event > span {
  width: 20px;
  height: 20px;
  font-size: 8px;
}
.pss-merged-event strong {
  color: #58a6ff;
}
.pss-reply-stack {
  display: grid;
  min-height: 94px;
}
.pss-reply-stack > .pss-comment-card {
  position: relative;
  inset: auto;
  grid-area: 1 / 1;
}
.pss-posted-reply {
  align-self: start;
}
.pss-reply-composer p {
  min-height: 38px;
  margin: 5px;
  padding: 6px;
  font-size: 7.5px;
}
.pss-reply-composer footer {
  padding: 0 5px 5px;
}
.pss-close-button {
  display: inline-block;
  white-space: nowrap;
}
.pss-closed-event > span {
  border-color: rgba(130, 80, 223, 0.7);
  color: #d2a8ff;
}
.pss-thanks-comment {
  padding-bottom: 4px;
}
.pss-pointer {
  position: absolute;
  z-index: 50;
  top: 0;
  left: 0;
  width: 22px;
  height: 27px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.5));
  will-change: transform;
}
.pss-pointer svg {
  position: relative;
  z-index: 2;
  width: 22px;
  height: 27px;
}
.pss-pointer-ring {
  position: absolute;
  z-index: 1;
  top: -12px;
  left: -12px;
  width: 30px;
  height: 30px;
  border: 2px solid #119eff;
  border-radius: 50%;
  background: rgba(17, 158, 255, 0.18);
}
@keyframes pss-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes pss-caret {
  50% {
    opacity: 0;
  }
}

@container (max-width: 560px) {
  .pss-issue-meta,
  .pss-issue-sidebar {
    display: none;
  }
  .pss-composer-grid {
    grid-template-columns: 25px minmax(0, 1fr);
  }
  .pss-issue-layout {
    grid-template-columns: 1fr;
  }
  .pss-gh-search {
    width: 110px;
  }
  .pss-mail-layout {
    grid-template-columns: 78px 116px minmax(0, 1fr);
  }
  .pss-vscode-layout {
    grid-template-columns: 32px 96px minmax(0, 1fr);
  }
  .pss-pr-body {
    grid-template-columns: minmax(0, 1fr) 170px;
  }
  .pss-code-status {
    font-size: 12px;
  }
}
@container (max-width: 450px) {
  .pss-support-browser > .pss-github-global,
  .pss-support-browser > .pss-repo-line {
    display: none;
  }
  .pss-support-browser .pss-pr-view,
  .pss-support-browser .pss-support-issues-list,
  .pss-support-browser .pss-support-issue {
    inset: 31px 0 0;
  }
  .pss-mailboxes,
  .pss-explorer {
    display: none;
  }
  .pss-mail-layout {
    grid-template-columns: 112px minmax(0, 1fr);
  }
  .pss-vscode-layout {
    grid-template-columns: 32px minmax(0, 1fr);
  }
  .pss-pr-body {
    grid-template-columns: 1fr;
  }
  .pss-pr-summary {
    display: none;
  }
  .pss-resolution-timeline {
    max-width: 100%;
  }
  .pss-issues-list-head,
  .pss-support-issue-row aside em {
    display: none;
  }
  .pss-repo-tabs span:nth-child(n + 4) {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pss-spinner,
  .pss-typing-caret {
    animation: none;
  }
}
</style>
