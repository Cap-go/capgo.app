// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import ChannelSelfAssignMockup from '../src/components/dashboard/ChannelSelfAssignMockup.vue'

const animation = vi.hoisted(() => ({
  options: null as any,
  timeline: {
    addLabel: vi.fn().mockReturnThis(),
    fromTo: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    to: vi.fn().mockReturnThis(),
  },
}))

vi.mock('gsap', () => ({
  default: { registerPlugin: vi.fn(), set: vi.fn(), timeline: () => animation.timeline },
}))
vi.mock('gsap/MotionPathPlugin', () => ({ MotionPathPlugin: {} }))
vi.mock('~/composables/useOnboardingChannelAnimation', () => ({
  useOnboardingChannelAnimation: (options: unknown) => {
    animation.options = options
    return { continueOnboarding: vi.fn(), goBack: vi.fn(), replay: vi.fn() }
  },
}))

let app: App | undefined

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
})

describe('self-assignment animation path alignment', () => {
  it.each([0, 287])('uses the packet canvas origin with a %i px centered margin', (margin) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ChannelSelfAssignMockup, { embedded: true })
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
    app.mount(container)

    const stage = container.querySelector<HTMLElement>('.csa-stage')!
    const canvas = container.querySelector<HTMLElement>('.csa-routing-canvas')!
    const svg = container.querySelector<SVGSVGElement>('.csa-routing-network')!
    const canvasLeft = 20 + margin
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 100, 1024 + margin * 2, 512))
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(canvasLeft, 100, 1024, 512))
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(canvasLeft, 100, 1024, 512))
    Object.defineProperty(svg, 'createSVGPoint', {
      value: () => ({
        x: 0,
        y: 0,
        matrixTransform() { return { x: this.x + canvasLeft, y: this.y + 100 } },
      }),
    })
    for (const path of svg.querySelectorAll('path')) {
      Object.defineProperties(path, {
        getScreenCTM: { value: () => ({}) },
        getTotalLength: { value: () => 100 },
        getPointAtLength: { value: (length: number) => ({ x: 500, y: 50 + length }) },
      })
    }

    animation.options.buildTimeline()

    for (const selector of ['.csa-request-packet', '.csa-policy-packet', '.csa-response-packet']) {
      const packet = container.querySelector(selector)
      const paths = animation.timeline.to.mock.calls
        .filter(([target, vars]) => target === packet && vars.motionPath)
        .map(([, vars]) => vars.motionPath.path)
      expect(paths.length).toBeGreaterThan(0)
      for (const points of paths) {
        expect(points).toHaveLength(33)
        expect(points.every((point: { x: number, y: number }) => point.x === 500 && point.y >= 50 && point.y <= 150)).toBe(true)
      }
    }
  })
})
