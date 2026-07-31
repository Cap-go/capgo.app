import type { Chart, TooltipItem as ChartTooltipItem, TooltipLabelStyle, TooltipModel } from 'chart.js'
import { useDark } from '@vueuse/core'
import { formatLocalDateLong } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

interface TooltipContext {
  chart: Chart
  tooltip: TooltipModel<'bar' | 'line'>
}

interface ProcessedTooltipItem {
  body: string[]
  value: number
  count?: number | null
  colors: TooltipLabelStyle
  appId?: string
  label?: string
}

export interface TooltipClickHandler {
  onAppClick?: (appId: string, clickContext?: { date: Date, dataIndex: number }) => void
  appIdByLabel?: Record<string, string> // Maps app label/name to app ID
}

function getCanvasContext(ctx: unknown): CanvasRenderingContext2D | null {
  if (ctx && typeof (ctx as CanvasRenderingContext2D).save === 'function')
    return ctx as CanvasRenderingContext2D

  return null
}

function hasConnectedCanvas(chart: Pick<Chart, 'canvas' | 'ctx'>): boolean {
  const ctx = getCanvasContext(chart.ctx)
  const canvas = chart.canvas ?? ctx?.canvas
  return canvas?.isConnected !== false
}

function canSafelyUpdateChart(chart: Chart): boolean {
  return !!getCanvasContext(chart.ctx) && hasConnectedCanvas(chart)
}

function clearTooltipSelection(chart: Chart) {
  if (!canSafelyUpdateChart(chart))
    return

  chart.setActiveElements([])
  chart.update('none')
}

function formatTooltipValue(value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value))
    return '0'

  return formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/**
 * Calculate the actual date from the chart data index
 * @param dataIndex The index in the chart data array
 * @param dateStartOrUseBillingPeriod Either a Date for billing start, or boolean (false = last 30 days mode)
 */
function getDateFromIndex(dataIndex: number, dateStartOrUseBillingPeriod?: Date | boolean): Date {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (dateStartOrUseBillingPeriod instanceof Date) {
    // Billing period mode: start from billing start date
    const date = new Date(dateStartOrUseBillingPeriod)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() + dataIndex)
    return date
  }

  // Last 30 days mode (dateStartOrUseBillingPeriod is false or undefined)
  const date = new Date(today)
  date.setDate(date.getDate() - 29 + dataIndex) // 29 days ago + index
  return date
}

/**
 * Format a date for tooltip display using the app's locale (e.g., "December 10" in English, "10 décembre" in French)
 */
function formatDateForTooltip(date: Date): string {
  return formatLocalDateLong(date)
}

function getDatasetBaseValue(
  chart: Chart | undefined,
  dataset: any,
  datasetIndex: number,
  dataIndex: number,
  parsedY: unknown,
  isAccumulated: boolean = false,
) {
  const metaValues = Array.isArray(dataset?.metaBaseValues) ? dataset.metaBaseValues as Array<number | null> : null
  if (metaValues) {
    const candidate = metaValues[dataIndex]
    if (typeof candidate === 'number' && Number.isFinite(candidate))
      return candidate
    return null
  }

  if (typeof parsedY !== 'number' || Number.isNaN(parsedY))
    return null

  // In non-accumulated charts, parsedY is already the real value.
  if (!isAccumulated)
    return parsedY

  if (!chart || datasetIndex <= 0)
    return parsedY

  const previousDataset: any = chart.data?.datasets?.[datasetIndex - 1]
  const previousRaw = Array.isArray(previousDataset?.data) ? previousDataset.data[dataIndex] : undefined
  const previousValue = typeof previousRaw === 'number' && Number.isFinite(previousRaw) ? previousRaw : 0
  return parsedY - previousValue
}

/**
 * Creates a custom Chart.js tooltip with smart positioning and scrollable content
 * @param context Chart.js tooltip context
 * @param isAccumulated Whether the chart is in accumulated mode
 * @param hasMultipleDatasets Whether the chart has multiple datasets (apps)
 * @param dateStartOrUseBillingPeriod Either a Date for billing start, or boolean for mode
 * @param clickHandler Optional click handler for interactive tooltip items
 */
export function createCustomTooltip(context: TooltipContext, isAccumulated: boolean = false, hasMultipleDatasets: boolean = true, dateStartOrUseBillingPeriod?: Date | boolean, clickHandler?: TooltipClickHandler) {
  const { chart, tooltip } = context
  const { canvas } = chart
  const isDark = useDark()
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0

  // Get or create tooltip element
  let tooltipEl = chart.canvas.parentNode?.querySelector('.chartjs-tooltip') as HTMLElement | null
  if (!tooltipEl) {
    tooltipEl = document.createElement('div')
    tooltipEl.className = 'chartjs-tooltip'
    tooltipEl.style.opacity = '0'
    tooltipEl.style.position = 'absolute'
    tooltipEl.style.background = isDark.value ? 'rgba(17, 24, 39, 0.97)' : 'rgba(255, 255, 255, 1)'
    tooltipEl.style.backdropFilter = 'blur(12px)'
    tooltipEl.style.borderRadius = '8px'
    tooltipEl.style.color = isDark.value ? 'white' : 'black'
    tooltipEl.style.border = isDark.value ? '1px solid rgba(55, 65, 81, 0.6)' : '1px solid rgba(209, 213, 219, 0.8)'
    // Default to non-interactive; we'll enable pointer events when needed
    tooltipEl.style.pointerEvents = 'none'
    tooltipEl.style.transform = 'translate(-50%, 0)'
    tooltipEl.style.transition = 'all .1s ease'
    tooltipEl.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.15), 0 4px 10px rgba(0, 0, 0, 0.1)'
    tooltipEl.style.zIndex = '1000'
    tooltipEl.style.fontSize = '12px'
    tooltipEl.style.maxHeight = '60vh'
    tooltipEl.style.overflow = 'hidden'
    tooltipEl.style.minWidth = '200px'
    tooltipEl.style.maxWidth = '300px'
    chart.canvas.parentNode?.appendChild(tooltipEl)

    // Hover state listeners are attached later when we know we need pointer events

    // Add touch event listener for mobile to dismiss tooltip
    if (isMobile) {
      const dismissTooltip = (e: TouchEvent) => {
        // Check if the touch is not on the chart canvas
        if (!canvas.contains(e.target as Node)) {
          tooltipEl!.style.opacity = '0'
          clearTooltipSelection(chart)
        }
      }

      // Store the listener reference to remove it later if needed
      (tooltipEl as any).dismissListener = dismissTooltip
      document.addEventListener('touchstart', dismissTooltip, { passive: true })
    }
  }

  // Clear any existing auto-hide timer
  if ((tooltipEl as any).hideTimer) {
    clearTimeout((tooltipEl as any).hideTimer)
  }

  // Hide if no tooltip (but not if user is hovering over the tooltip for interactive mode)
  if (tooltip.opacity === 0) {
    // If tooltip is being hovered and we have click handlers, don't hide it
    if ((tooltipEl as any).isHovered && clickHandler?.onAppClick) {
      return
    }
    tooltipEl.style.opacity = '0'
    return
  }

  // Auto-hide on mobile after 3 seconds
  if (isMobile) {
    (tooltipEl as any).hideTimer = setTimeout(() => {
      tooltipEl.style.opacity = '0'
      // Trigger chart update to clear tooltip
      clearTooltipSelection(chart)
    }, 3000)
  }

  // Set content
  if (tooltip.body) {
    const dataPoints = tooltip.dataPoints || []

    const dataIndex = dataPoints[0]?.dataIndex ?? 0
    const tooltipDate = getDateFromIndex(dataIndex, dateStartOrUseBillingPeriod)
    const formattedTitle = formatDateForTooltip(tooltipDate)

    // Create an array of items with their values, colors, and labels
    const items: ProcessedTooltipItem[] = dataPoints.map((dataPoint, index) => {
      const datasetIndex = dataPoint.datasetIndex ?? 0
      const dataIndex = dataPoint.dataIndex ?? 0
      const dataset = dataPoint.dataset as any
      const baseValue = getDatasetBaseValue(chart, dataset, datasetIndex, dataIndex, dataPoint.parsed?.y, isAccumulated)
      const numericValue = typeof baseValue === 'number' && Number.isFinite(baseValue) ? baseValue : 0
      const countValues = Array.isArray(dataset?.metaCountValues) ? dataset.metaCountValues as Array<number | null | undefined> : null
      const countCandidate = countValues ? countValues[dataIndex] : null
      const numericCount = typeof countCandidate === 'number' && Number.isFinite(countCandidate)
        ? Math.max(0, Math.round(countCandidate))
        : null
      const label = dataset?.label ?? ''
      // Look up the app ID from the label using the provided mapping
      const appId = clickHandler?.appIdByLabel?.[label]
      const formattedValue = numericCount !== null
        ? `${formatTooltipValue(numericValue)}% (${formatNumberValue(numericCount)})`
        : formatTooltipValue(numericValue)

      return {
        body: [`${formattedValue} - ${label}`],
        value: numericValue,
        count: numericCount,
        colors: tooltip.labelColors[index],
        appId,
        label,
      }
    }).filter(item => item.value !== 0 || (item.count ?? 0) !== 0)

    // Sort by value in descending order (highest to lowest)
    items.sort((a, b) => b.value - a.value)

    // Calculate total value based on mode - matching UsageCard logic
    let totalValue: number
    const isSingleApp = !hasMultipleDatasets

    if (isSingleApp) {
      if (isAccumulated) {
        // Single app cumulative mode: for the tooltip at a specific point,
        // we show the accumulated value at that point (which is already calculated in the data)
        const cumulativeValues = tooltip.dataPoints?.map((point: any) => point.parsed.y) || []
        totalValue = cumulativeValues.length > 0 ? cumulativeValues[0] : 0
      }
      else {
        // Single app daily mode: show the raw daily value
        totalValue = items.reduce((sum, item) => sum + item.value, 0)
      }
    }
    else {
      // Multi-app view
      totalValue = items.reduce((sum, item) => sum + item.value, 0)
    }
    const totalCount = items.reduce((sum, item) => sum + (typeof item.count === 'number' ? item.count : 0), 0)
    const hasCountValues = items.some(item => typeof item.count === 'number')

    const titleColor = isDark.value ? '#e5e7eb' : '#374151'
    const totalColor = isDark.value ? '#60a5fa' : '#2563eb'
    const container = document.createElement('div')
    container.style.padding = '12px'

    // Add title with formatted date
    const titleEl = document.createElement('div')
    titleEl.style.fontWeight = '600'
    titleEl.style.marginBottom = '4px'
    titleEl.style.color = titleColor
    titleEl.textContent = formattedTitle
    container.appendChild(titleEl)

    // Add total value
    if (items.length > 1) {
      const totalEl = document.createElement('div')
      totalEl.style.fontWeight = '600'
      totalEl.style.marginBottom = '8px'
      totalEl.style.paddingBottom = '8px'
      totalEl.style.borderBottom = `1px solid ${isDark.value ? 'rgba(75, 85, 99, 0.3)' : 'rgba(209, 213, 219, 0.3)'}`
      totalEl.style.color = totalColor
      totalEl.textContent = hasCountValues
        ? `Total devices: ${formatNumberValue(Math.round(totalCount))}`
        : `Total: ${formatTooltipValue(totalValue)}`
      container.appendChild(totalEl)
    }

    // Add body with scrollable content (now sorted)
    const bodyEl = document.createElement('div')
    bodyEl.className = 'tooltip-body'
    bodyEl.style.maxHeight = 'var(--tooltip-body-max-height, 40vh)'
    bodyEl.style.overflowY = 'auto'
    const hasClickHandler = !!clickHandler?.onAppClick
    items.forEach((item) => {
      // Convert color to string if it's not already
      const bgColor = typeof item.colors.backgroundColor === 'string' ? item.colors.backgroundColor : '#666'
      const borderColor = typeof item.colors.borderColor === 'string' ? item.colors.borderColor : '#999'

      const colorIndicator = document.createElement('div')
      colorIndicator.style.width = '12px'
      colorIndicator.style.height = '12px'
      colorIndicator.style.backgroundColor = bgColor
      colorIndicator.style.border = `1px solid ${borderColor}`
      colorIndicator.style.borderRadius = '2px'
      colorIndicator.style.marginRight = '8px'
      colorIndicator.style.flexShrink = '0'

      // Make item clickable if we have a click handler and app ID
      const isClickable = hasClickHandler && item.appId
      const rowEl = document.createElement('div')
      rowEl.style.display = 'flex'
      rowEl.style.alignItems = 'center'
      rowEl.style.marginBottom = '4px'
      rowEl.style.padding = '4px 6px'
      rowEl.style.marginLeft = '-6px'
      rowEl.style.marginRight = '-6px'
      rowEl.style.borderRadius = '4px'

      if (isClickable) {
        rowEl.classList.add('tooltip-app-item')
        rowEl.style.cursor = 'pointer'
        rowEl.style.transition = 'background-color 0.15s ease'
        rowEl.dataset.appId = String(item.appId)
      }

      const textContent = document.createElement('span')
      textContent.style.fontSize = '11px'
      textContent.textContent = item.body.join(' ')

      rowEl.appendChild(colorIndicator)
      rowEl.appendChild(textContent)
      bodyEl.appendChild(rowEl)
    })

    container.appendChild(bodyEl)
    tooltipEl.replaceChildren(container)

    // Add click handlers to clickable items
    if (hasClickHandler) {
      const clickableItems = tooltipEl.querySelectorAll('.tooltip-app-item[data-app-id]')
      clickableItems.forEach((el) => {
        const element = el as HTMLElement
        const appId = element.dataset.appId
        if (appId) {
          // Add hover effect
          element.addEventListener('mouseenter', () => {
            element.style.backgroundColor = isDark.value ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.8)'
          })
          element.addEventListener('mouseleave', () => {
            element.style.backgroundColor = 'transparent'
          })
          // Add click handler with date context
          element.addEventListener('click', (e) => {
            e.stopPropagation()
            clickHandler.onAppClick!(appId, { date: tooltipDate, dataIndex })
            // Hide tooltip after click
            tooltipEl.style.opacity = '0'
          })
        }
      })
    }
  }

  // Position tooltip with smart viewport bounds checking
  positionTooltip(tooltipEl, canvas, tooltip)

  // Enable pointer events only when needed (clicks or scrolling)
  const bodyEl = tooltipEl.querySelector('.tooltip-body') as HTMLElement | null
  const bodyScrollable = !!bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight
  const needsInteraction = !!clickHandler?.onAppClick || bodyScrollable
  tooltipEl.style.pointerEvents = needsInteraction ? 'auto' : 'none'

  if (needsInteraction && !(tooltipEl as any).hoverHandlersAttached) {
    tooltipEl.addEventListener('mouseenter', () => {
      (tooltipEl as any).isHovered = true
      if ((tooltipEl as any).hideTimer) {
        clearTimeout((tooltipEl as any).hideTimer)
      }
    })
    tooltipEl.addEventListener('mouseleave', () => {
      ;(tooltipEl as any).isHovered = false
      ;(tooltipEl as any).hideTimer = setTimeout(() => {
        if (!(tooltipEl as any).isHovered) {
          tooltipEl!.style.opacity = '0'
          clearTooltipSelection(chart)
        }
      }, 100)
    })
    ;(tooltipEl as any).hoverHandlersAttached = true
  }
}

/**
 * Positions the tooltip element with intelligent viewport bounds checking
 * @param tooltipEl The tooltip DOM element
 * @param canvas The chart canvas element
 * @param tooltip Chart.js tooltip object
 */
function positionTooltip(tooltipEl: HTMLElement, canvas: HTMLCanvasElement, tooltip: any) {
  // Position relative to the canvas parent (which is where tooltip is appended)
  // Use tooltip.caretX/Y directly since they're relative to the canvas
  let left = tooltip.caretX
  let top = tooltip.caretY

  // Get canvas dimensions for bounds checking
  const canvasWidth = canvas.offsetWidth
  const canvasHeight = canvas.offsetHeight

  // Constrain tooltip size to the canvas to avoid clipping in dense charts
  const maxTooltipWidth = Math.max(180, canvasWidth - 20)
  const maxTooltipHeight = Math.max(160, canvasHeight - 20)
  tooltipEl.style.maxWidth = `${Math.min(320, maxTooltipWidth)}px`
  tooltipEl.style.minWidth = `${Math.min(200, maxTooltipWidth)}px`
  tooltipEl.style.maxHeight = `${maxTooltipHeight}px`
  // Reserve space for title/total padding so body can scroll without nested scrollbars
  const bodyMaxHeight = Math.max(120, maxTooltipHeight - 80)
  tooltipEl.style.setProperty('--tooltip-body-max-height', `${bodyMaxHeight}px`)

  // Get tooltip dimensions
  const tooltipRect = tooltipEl.getBoundingClientRect()
  const tooltipWidth = tooltipRect.width
  const tooltipHeight = tooltipRect.height

  // Horizontal positioning - keep tooltip within canvas bounds
  // Center the tooltip on the caret position, then clamp within bounds
  const halfWidth = tooltipWidth / 2
  const minLeft = halfWidth + 10
  const maxLeft = canvasWidth - halfWidth - 10
  if (minLeft > maxLeft) {
    left = canvasWidth / 2
  }
  else {
    left = Math.min(Math.max(left, minLeft), maxLeft)
  }

  // Always use centered transform
  tooltipEl.style.transform = 'translate(-50%, 0)'

  // Vertical positioning - prefer below caret, then above; clamp to canvas
  const minTop = 10
  const maxTop = canvasHeight - tooltipHeight - 10
  if (tooltipHeight + 20 > canvasHeight) {
    top = minTop
  }
  else if (top + tooltipHeight > canvasHeight - 10) {
    top = tooltip.caretY - tooltipHeight - 10
  }
  if (top < minTop)
    top = minTop
  if (maxTop >= minTop && top > maxTop)
    top = maxTop

  // Apply position
  tooltipEl.style.left = `${left}px`
  tooltipEl.style.top = `${top}px`
  tooltipEl.style.opacity = '1'
}

/**
 * Plugin to draw vertical line at tooltip position
 */
interface VerticalLinePluginOptions {
  color?: string
  glowColor?: string
  lineWidth?: number
  glowWidth?: number
  dash?: number[]
  glowDash?: number[]
}

function isDarkMode() {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
    return true

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
    return window.matchMedia('(prefers-color-scheme: dark)').matches

  return false
}

export const verticalLinePlugin = {
  id: 'verticalLine',
  afterDatasetsDraw(chart: Chart) {
    if (!hasConnectedCanvas(chart))
      return

    const active = chart.tooltip?.getActiveElements()
    if (chart.tooltip && active && active.length > 0) {
      const activePoint = active[0]
      const ctx = getCanvasContext(chart.ctx)
      if (!ctx)
        return
      const x = activePoint.element.x
      const topY = chart.scales.y.top
      const bottomY = chart.scales.y.bottom
      const pluginOptions = (chart.options?.plugins as any)?.verticalLine as VerticalLinePluginOptions | undefined
      const dark = isDarkMode()

      const lineColor = pluginOptions?.color ?? (dark ? 'rgba(255, 255, 255, 0.7)' : 'rgba(49, 70, 87, 0.6)')
      const glowColor = pluginOptions?.glowColor ?? (dark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(129, 140, 248, 0.25)')
      const lineWidth = pluginOptions?.lineWidth ?? 2
      const glowWidth = pluginOptions?.glowWidth ?? 4
      const dash = pluginOptions?.dash ?? [8, 4]
      const glowDash = pluginOptions?.glowDash ?? dash

      // Save context state
      ctx.save()

      // Set higher z-index by drawing last
      ctx.globalCompositeOperation = 'source-over'

      // Draw vertical line with more visibility
      ctx.beginPath()
      ctx.moveTo(x, topY)
      ctx.lineTo(x, bottomY)
      ctx.lineWidth = lineWidth
      ctx.strokeStyle = lineColor
      ctx.setLineDash(dash)
      ctx.stroke()

      if (glowWidth > 0 && glowColor) {
        // Draw a subtle glow effect for better visibility
        ctx.beginPath()
        ctx.moveTo(x, topY)
        ctx.lineTo(x, bottomY)
        ctx.lineWidth = glowWidth
        ctx.strokeStyle = glowColor
        ctx.setLineDash(glowDash)
        ctx.stroke()
      }

      // Restore context state
      ctx.restore()
    }
  },
}

interface TodayLinePluginOptions {
  enabled?: boolean
  xIndex?: number
  label?: string
  color?: string
  glowColor?: string
  badgeFill?: string
  textColor?: string
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)

  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function resolveScale(chart: Chart, axisId: 'x' | 'y') {
  const scale = (chart.scales as Record<string, any>)[axisId]
  if (scale)
    return scale

  // Fallback to first matching axis for legacy ids
  const fallbackKey = Object.keys(chart.scales).find(key => key.toLowerCase().startsWith(axisId))
  return fallbackKey ? (chart.scales as Record<string, any>)[fallbackKey] : undefined
}

export const todayLinePlugin = {
  id: 'todayLine',
  afterDatasetsDraw(chart: Chart, _args: unknown, pluginOptions?: TodayLinePluginOptions) {
    const options = pluginOptions ?? {}
    if (!options.enabled)
      return

    if (!hasConnectedCanvas(chart))
      return

    const xScale = resolveScale(chart, 'x')
    const yScale = resolveScale(chart, 'y')
    if (!xScale || !yScale)
      return

    const index = typeof options.xIndex === 'number' ? options.xIndex : -1
    if (index < 0)
      return

    const x = typeof xScale.getPixelForValue === 'function'
      ? xScale.getPixelForValue(index)
      : undefined

    if (typeof x !== 'number' || Number.isNaN(x))
      return

    const ctx = getCanvasContext(chart.ctx)
    if (!ctx)
      return
    const topY = yScale.top ?? chart.chartArea?.top
    const bottomY = yScale.bottom ?? chart.chartArea?.bottom
    if (typeof topY !== 'number' || typeof bottomY !== 'number')
      return

    const strokeColor = options.color ?? 'rgba(99, 102, 241, 0.6)'
    const glowColor = options.glowColor ?? 'rgba(159, 168, 255, 0.25)'

    ctx.save()
    ctx.globalCompositeOperation = 'source-over'

    ctx.beginPath()
    ctx.moveTo(x, topY)
    ctx.lineTo(x, bottomY)
    ctx.lineWidth = 2
    ctx.strokeStyle = strokeColor
    ctx.setLineDash([8, 4])
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(x, topY)
    ctx.lineTo(x, bottomY)
    ctx.lineWidth = 4
    ctx.strokeStyle = glowColor
    ctx.setLineDash([8, 4])
    ctx.stroke()

    ctx.setLineDash([])

    if (options.label) {
      const badgeFill = options.badgeFill ?? 'rgba(199, 210, 254, 0.85)'
      const textColor = options.textColor ?? '#312e81'
      const fontSize = 12
      const paddingX = 10
      const paddingY = 6
      const badgeY = (chart.chartArea?.top ?? topY) + 8

      ctx.font = `${fontSize}px sans-serif`
      const labelWidth = ctx.measureText(options.label).width
      const badgeWidth = labelWidth + paddingX * 2
      const badgeHeight = fontSize + paddingY

      let badgeX = x - badgeWidth / 2
      const chartLeft = chart.chartArea?.left ?? 0
      const chartRight = chart.chartArea?.right ?? chart.width

      if (badgeX < chartLeft + 4)
        badgeX = chartLeft + 4
      if (badgeX + badgeWidth > chartRight - 4)
        badgeX = chartRight - badgeWidth - 4

      drawRoundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 6)
      ctx.fillStyle = badgeFill
      ctx.fill()

      ctx.lineWidth = 1
      ctx.strokeStyle = strokeColor
      ctx.stroke()

      ctx.fillStyle = textColor
      ctx.fillText(options.label, badgeX + paddingX, badgeY + badgeHeight - paddingY / 2)
    }

    ctx.restore()
  },
}

/**
 * Creates tooltip configuration for Chart.js options
 * @param hasMultipleDatasets Whether the chart has multiple datasets (apps)
 * @param isAccumulated Whether the chart is in accumulated/cumulative mode
 * @param dateStartOrUseBillingPeriod Either a Date for billing start, or boolean for mode
 * @param clickHandler Optional click handler for interactive tooltip items
 * @returns Chart.js tooltip configuration object
 */
export function createTooltipConfig(hasMultipleDatasets: boolean, isAccumulated: boolean = false, dateStartOrUseBillingPeriod?: Date | boolean, clickHandler?: TooltipClickHandler) {
  return {
    mode: 'index' as const,
    intersect: false,
    position: 'nearest' as const,
    // Always use custom tooltip for consistent design across single and multi-app views
    external: (context: TooltipContext) => createCustomTooltip(context, isAccumulated, hasMultipleDatasets, dateStartOrUseBillingPeriod, clickHandler),
    enabled: false, // Always disable default tooltip since we use custom
    callbacks: {
      title(tooltipItems: ChartTooltipItem<any>[]) {
        // Format the title to show full date like "December 10"
        const dataIndex = tooltipItems[0].dataIndex
        const date = getDateFromIndex(dataIndex, dateStartOrUseBillingPeriod)
        return formatDateForTooltip(date)
      },
      label(context: ChartTooltipItem<any>) {
        if (isAccumulated && !hasMultipleDatasets) {
          // For single dataset in accumulated mode, show total
          return `Total: ${formatNumberValue(context.parsed.y)}`
        }
        else if (hasMultipleDatasets) {
          const datasetIndex = context.datasetIndex ?? 0
          const dataIndex = context.dataIndex ?? 0
          const baseValue = getDatasetBaseValue(context.chart, context.dataset, datasetIndex, dataIndex, context.parsed?.y, isAccumulated)
          const numericValue = typeof baseValue === 'number' && Number.isFinite(baseValue) ? baseValue : 0
          const countValues = Array.isArray((context.dataset as any)?.metaCountValues)
            ? ((context.dataset as any).metaCountValues as Array<number | null | undefined>)
            : null
          const countCandidate = countValues ? countValues[dataIndex] : null
          const numericCount = typeof countCandidate === 'number' && Number.isFinite(countCandidate)
            ? Math.max(0, Math.round(countCandidate))
            : null
          if (numericCount !== null)
            return `${formatTooltipValue(numericValue)}% (${formatNumberValue(numericCount)}) - ${context.dataset.label}`
          return `${formatTooltipValue(numericValue)} - ${context.dataset.label}`
        }
        // For single dataset in daily mode, use default formatting
        return undefined
      },
      afterLabel(context: ChartTooltipItem<any>) {
        // In accumulated mode, show the daily value in parentheses
        if (isAccumulated && !hasMultipleDatasets && context.parsed.y > 0) {
          const dataIndex = context.dataIndex
          const currentValue = context.parsed.y
          const previousValue = dataIndex > 0 ? context.dataset.data[dataIndex - 1] : 0
          const dailyValue = currentValue - previousValue
          return dailyValue > 0 ? `(+${formatNumberValue(dailyValue)} today)` : undefined
        }
        return undefined
      },
    },
  }
}
