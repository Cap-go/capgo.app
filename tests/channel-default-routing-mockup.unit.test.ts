import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mockupSource = readFileSync(new URL('../src/components/dashboard/ChannelDefaultRoutingMockup.vue', import.meta.url), 'utf8')

function expectSourceOrder(source: string, markers: string[]) {
  let previousIndex = -1
  for (const marker of markers) {
    const index = source.indexOf(marker, previousIndex + 1)
    expect(index, `Expected source marker after previous marker: ${marker}`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

function sourceBetween(start: string, end: string) {
  const startIndex = mockupSource.indexOf(start)
  const endIndex = mockupSource.indexOf(end, startIndex)

  if (startIndex === -1)
    throw new Error(`Missing start marker in ChannelDefaultRoutingMockup.vue: ${start}`)
  if (endIndex === -1)
    throw new Error(`Missing end marker in ChannelDefaultRoutingMockup.vue: ${end}`)

  return mockupSource.slice(startIndex, endIndex)
}

describe('channel default routing animation', () => {
  it.concurrent('moves packets along the connectors as they are rendered on screen', () => {
    const timeline = sourceBetween('function buildTimeline(root: HTMLElement)', 'function createAnimation()')

    expect(mockupSource).toContain('function renderedPathPoints(')
    expect(mockupSource).toContain('path.getScreenCTM()')
    expect(mockupSource).toContain('path.getPointAtLength(')
    expect(timeline).toContain('const requestPoints = renderedPathPoints(root, requestPath)')
    expect(timeline).toContain('const productionPoints = renderedPathPoints(root, productionPath)')
    expect(timeline).toContain('path: requestPoints')
    expect(timeline).toContain('path: productionPoints')
    expect(timeline).not.toContain('align: requestPath')
    expect(timeline).not.toContain('align: productionPath')
  })

  it.concurrent('keeps the installed badge outside the phone screen content', () => {
    const deviceMarkup = sourceBetween('<div class="cr-node cr-device-node">', '<div class="cr-device-meta">')

    expect(mockupSource).toContain('.cr-phone > .cr-installed-check {')
    const installedBadgeRule = sourceBetween('.cr-phone > .cr-installed-check {', '.cr-installed-check svg {')

    expect(deviceMarkup).toContain('<span class="cr-installed-check" data-test="phone-installed-check"><IconCheck /></span>')
    expect(installedBadgeRule).toContain('right: -0.22rem;')
    expect(installedBadgeRule).toContain('bottom: -0.22rem;')
  })

  it.concurrent('centers the phone itself on the vertical connector', () => {
    const deviceNodeRule = sourceBetween('.cr-device-node {', '.cr-phone {')
    const deviceMetaRule = sourceBetween('.cr-device-meta {', '.cr-node-label {')

    expect(deviceNodeRule).toContain('display: block;')
    expect(deviceNodeRule).not.toContain('gap:')
    expect(deviceMetaRule).toContain('position: absolute;')
    expect(deviceMetaRule).toContain('left: calc(100% + 0.8rem);')
    expect(deviceMetaRule).toContain('transform: translateY(-50%);')
  })

  it.concurrent('keeps the response card close to the left edge of the phone', () => {
    const requestBubbleRule = sourceBetween('.cr-request-bubble {', '.cr-response-bubble {')
    const responseBubbleRule = sourceBetween('.cr-response-bubble {', '.cr-bubble::before {')

    expect(requestBubbleRule).toContain('left: calc(50% + 7rem);')
    expect(responseBubbleRule).toContain('right: calc(50% + 6.2rem);')
  })

  it.concurrent('keeps the onboarding action in the footer while compacting the embedded animation', () => {
    expect(mockupSource).toContain('<footer v-if="props.embedded" class="flex items-center justify-between border-t')
    expect(mockupSource).toContain('data-test="channel-default-routing-continue"')
    expect(mockupSource).toContain(`@click="emit('continue')"`)

    const embeddedStageRule = sourceBetween('.cr-page-embedded .cr-stage {', '@media (min-width: 640px)')
    expect(embeddedStageRule).toContain('min-height: 27rem;')

    const embeddedPositions = sourceBetween('.cr-page-embedded .cr-device-node {', '@media (prefers-reduced-motion: reduce)')
    expect(embeddedPositions).toContain('.cr-page-embedded .cr-capgo-node {')
    expect(embeddedPositions).toContain('.cr-page-embedded .cr-channels-label {')
    expect(embeddedPositions).toContain('.cr-page-embedded .cr-channel-node {')
    expect(embeddedPositions).toContain('width: min(12rem, calc(33.333% - 0.75rem));')
  })

  it.concurrent('rebuilds rendered motion paths after a debounced resize and cleans up observers', () => {
    expect(mockupSource).toContain('let resizeObserver: ResizeObserver | null = null')
    expect(mockupSource).toContain('let resizeAnimationFrame: number | null = null')
    expect(mockupSource).toContain('function refreshAnimationAfterResize()')
    expect(mockupSource).toContain('window.cancelAnimationFrame(resizeAnimationFrame)')
    expect(mockupSource).toContain('window.requestAnimationFrame(() => {')
    expect(mockupSource).toContain('resizeObserver = new ResizeObserver(refreshAnimationAfterResize)')
    expect(mockupSource).toContain('resizeObserver.observe(rootEl.value)')
    expect(mockupSource).toContain('resizeObserver?.disconnect()')

    const createAnimation = sourceBetween('function createAnimation()', 'function refreshAnimationAfterResize()')
    expectSourceOrder(createAnimation, [
      'timeline?.kill()',
      'media?.revert()',
      'const root = rootEl.value',
      'media = gsap.matchMedia()',
    ])
  })
})
