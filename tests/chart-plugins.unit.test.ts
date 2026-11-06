import { describe, expect, it, vi } from 'vitest'

import { inlineAnnotationPlugin } from '../src/services/chartAnnotations'
import { todayLinePlugin, verticalLinePlugin } from '../src/services/chartTooltip'

const y = { top: 10, bottom: 90 }

const draws = {
  'vertical hover line': (chart: Record<string, unknown>) => verticalLinePlugin.afterDatasetsDraw({
    ...chart,
    tooltip: { getActiveElements: () => [{ element: { x: 12 } }] },
    scales: { y },
    options: { plugins: {} },
  } as any),
  'today line': (chart: Record<string, unknown>) => todayLinePlugin.afterDatasetsDraw({
    ...chart,
    chartArea: y,
    scales: { x: { getPixelForValue: () => 24 }, y },
  } as any, undefined, { enabled: true, xIndex: 2, label: 'Today' }),
  'inline annotations': (chart: Record<string, unknown>) => inlineAnnotationPlugin.afterDatasetsDraw({
    ...chart,
    chartArea: { left: 0, right: 100 },
    scales: { x: { getPixelForValue: () => 10 }, y: { getPixelForValue: () => 20 } },
  } as any, undefined, {
    line_limit: { yMin: 3, yMax: 3, borderColor: '#fff', borderWidth: 1 },
    label_limit: { xValue: 1, yValue: 3, backgroundColor: '#000', content: ['Limit'], borderWidth: 1, font: { size: 12 } },
  } as any),
}

describe('chart plugins', () => {
  it.concurrent.each(Object.keys(draws) as (keyof typeof draws)[])('skips drawing the %s when the chart context is gone', (name) => {
    expect(() => draws[name]({ ctx: null })).not.toThrow()
  })

  it.concurrent.each(['vertical hover line', 'today line'] as const)('skips drawing the %s when the canvas is disconnected', (name) => {
    const ctx = { save: vi.fn() }

    expect(() => draws[name]({ ctx, canvas: { isConnected: false } })).not.toThrow()
    expect(ctx.save).not.toHaveBeenCalled()
  })
})
