/**
 * Shared Chart.js configuration utilities for consistent styling across all dashboard charts
 */

interface AxisConfig {
  grid?: {
    color: string
    drawBorder?: boolean
    borderColor?: string
  }
  border?: {
    display?: boolean
    color?: string
  }
  ticks?: {
    color: string
    maxRotation?: number
    autoSkip?: boolean
    callback?: (value: string | number) => string
  }
  beginAtZero?: boolean
  stacked?: boolean
  suggestedMax?: number
  max?: number
}

interface LegendConfig {
  display: boolean
  position?: 'top' | 'bottom' | 'left' | 'right'
  labels?: {
    color: string
    padding?: number
    font?: {
      size?: number
    }
  }
}

/**
 * Creates standardized x-axis configuration
 */
export function createXAxisConfig(isDark: boolean, options: { stacked?: boolean } = {}) {
  const gridColor = isDark ? '#323e4e' : '#cad5e2'
  const config: AxisConfig = {
    grid: {
      color: gridColor,
    },
    // Hide the axis border line (first vertical line) to match grid lines
    border: {
      display: false,
    },
    ticks: {
      color: isDark ? 'white' : 'black',
      maxRotation: 0,
      autoSkip: true,
    },
  }

  if (options.stacked !== undefined) {
    config.stacked = options.stacked
  }

  return config
}

/**
 * Creates standardized y-axis configuration
 */
export function createYAxisConfig(
  isDark: boolean,
  options: {
    stacked?: boolean
    suggestedMax?: number
    max?: number
    tickCallback?: (value: string | number) => string
  } = {},
) {
  const gridColor = isDark ? '#424e5f' : '#bfc9d6'
  const config: AxisConfig = {
    beginAtZero: true,
    grid: {
      color: gridColor,
    },
    // Hide the axis border line (bottom horizontal line) to match grid lines
    border: {
      display: false,
    },
    ticks: {
      color: isDark ? 'white' : 'black',
    },
  }

  if (options.stacked !== undefined) {
    config.stacked = options.stacked
  }

  if (options.suggestedMax !== undefined) {
    config.suggestedMax = options.suggestedMax
  }

  if (options.max !== undefined) {
    config.max = options.max
  }

  if (options.tickCallback) {
    config.ticks!.callback = options.tickCallback
  }

  return config
}

/**
 * Creates chart scales configuration (x and y axes)
 */
export function createChartScales(
  isDark: boolean,
  options: {
    xStacked?: boolean
    yStacked?: boolean
    suggestedMax?: number
    max?: number
    yTickCallback?: (value: string | number) => string
  } = {},
) {
  return {
    x: createXAxisConfig(isDark, { stacked: options.xStacked }),
    y: createYAxisConfig(isDark, {
      stacked: options.yStacked,
      suggestedMax: options.suggestedMax,
      max: options.max,
      tickCallback: options.yTickCallback,
    }),
  }
}

/**
 * Creates stacked chart scales with conditional stacking
 */
export function createStackedChartScales(isDark: boolean, stacked: boolean) {
  return createChartScales(isDark, {
    xStacked: stacked,
    yStacked: stacked,
  })
}

/**
 * Creates standardized legend configuration
 */
export function createLegendConfig(
  isDark: boolean,
  display: boolean,
  options: {
    position?: 'top' | 'bottom' | 'left' | 'right'
    fontSize?: number
    padding?: number
  } = {},
): LegendConfig {
  return {
    display,
    position: options.position ?? 'bottom',
    labels: {
      color: isDark ? 'white' : 'black',
      padding: options.padding ?? 10,
      font: {
        size: options.fontSize ?? 11,
      },
    },
  }
}
