/**
 * Demo chart data generator for displaying placeholder charts
 * when users have no apps or no real data yet.
 *
 * This creates realistic-looking but clearly fake data to make
 * empty dashboards more visually appealing.
 */

/**
 * Generate a realistic-looking growth curve with some randomness
 * Simulates organic app growth patterns
 */
function generateGrowthCurve(days: number, baseValue: number, growthFactor: number): number[] {
  const data: number[] = []
  let currentValue = baseValue

  for (let i = 0; i < days; i++) {
    // Add some daily variation (±20%)
    const dailyVariation = 0.8 + Math.random() * 0.4
    // Slight upward trend with growth factor
    const growth = 1 + (growthFactor * (i / days))
    currentValue = Math.round(baseValue * growth * dailyVariation)
    data.push(Math.max(0, currentValue))
  }

  return data
}

/**
 * Generate demo data for MAU (Monthly Active Users) chart
 */
export function generateDemoMauData(days: number = 30): number[] {
  return generateGrowthCurve(days, 1200, 0.3)
}

/**
 * Generate demo data for bandwidth chart (in GB)
 */
export function generateDemoBandwidthData(days: number = 30): number[] {
  return generateGrowthCurve(days, 50, 0.25).map(v => Math.round(v / 10) * 10)
}

/**
 * Generate demo data for storage chart (in MB)
 */
export function generateDemoStorageData(days: number = 30): number[] {
  // Storage tends to grow more steadily
  const data: number[] = []
  let storage = 500

  for (let i = 0; i < days; i++) {
    // Storage increases steadily with occasional jumps (new bundle uploads)
    if (Math.random() > 0.7) {
      storage += Math.round(20 + Math.random() * 50)
    }
    data.push(storage)
  }

  return data
}

/**
 * Generate demo data for update statistics chart
 * Returns data broken down by action type: requested, install, fail
 */
export function generateDemoUpdateStatsData(days: number = 30): {
  total: number[]
  byAction: {
    requested: number[]
    install: number[]
    fail: number[]
  }
} {
  const requested: number[] = []
  const install: number[] = []
  const fail: number[] = []
  const total: number[] = []

  for (let i = 0; i < days; i++) {
    // More requests on weekdays (index 0-4 are weekdays in a typical month start)
    const isWeekday = i % 7 < 5
    const baseFactor = isWeekday ? 1.2 : 0.8

    const dailyRequested = Math.round((150 + Math.random() * 100) * baseFactor)
    const dailyInstall = Math.round(dailyRequested * (0.7 + Math.random() * 0.15)) // 70-85% success rate
    const dailyFail = Math.round(dailyRequested * (0.01 + Math.random() * 0.02)) // 1-3% fail rate

    requested.push(dailyRequested)
    install.push(dailyInstall)
    fail.push(dailyFail)
    total.push(dailyRequested + dailyInstall + dailyFail)
  }

  return {
    total,
    byAction: { requested, install, fail },
  }
}

/**
 * Generate demo data for deployment statistics
 */
export function generateDemoDeploymentData(days: number = 30): number[] {
  const data: number[] = []

  for (let i = 0; i < days; i++) {
    // Deployments are sporadic - some days have none, some have multiple
    const hasDeployment = Math.random() > 0.6
    if (hasDeployment) {
      data.push(Math.round(1 + Math.random() * 3))
    }
    else {
      data.push(0)
    }
  }

  return data
}

/**
 * Generate demo data for bundle uploads
 */
export function generateDemoBundleUploadsData(days: number = 30): number[] {
  const data: number[] = []

  for (let i = 0; i < days; i++) {
    // Bundle uploads are even more sporadic than deployments
    const hasUpload = Math.random() > 0.75
    if (hasUpload) {
      data.push(Math.round(1 + Math.random() * 2))
    }
    else {
      data.push(0)
    }
  }

  return data
}

/**
 * Calculate demo totals for display
 */
export function calculateDemoTotal(data: number[]): number {
  return data.reduce((sum, val) => sum + val, 0)
}

/**
 * Calculate demo evolution percentage
 */
export function calculateDemoEvolution(data: number[]): number {
  const nonZeroDays = data.filter(count => count > 0)
  if (nonZeroDays.length < 2)
    return 0

  const lastDayCount = nonZeroDays[nonZeroDays.length - 1]
  const previousDayCount = nonZeroDays[nonZeroDays.length - 2]

  if (previousDayCount === 0)
    return lastDayCount > 0 ? 100 : 0

  return ((lastDayCount - previousDayCount) / previousDayCount) * 100
}

/**
 * Demo app names for multi-app breakdown display
 */
export const DEMO_APP_NAMES: { [key: string]: string } = {
  'demo-app-1': 'My Awesome App',
  'demo-app-2': 'Production App',
}

/**
 * Generate consistent demo data where the total is derived from the per-app breakdown.
 * This ensures the chart totals match when displaying stacked per-app data.
 */
export function generateConsistentDemoData(
  days: number,
  dataGenerator: (days: number) => number[],
): {
  total: number[]
  byApp: { [appId: string]: number[] }
} {
  // Generate per-app data first
  const app1Data = dataGenerator(days)
  const app2Data = dataGenerator(days)

  // Derive total from per-app data (sum each day)
  const total = app1Data.map((val, idx) => val + app2Data[idx])

  return {
    total,
    byApp: {
      'demo-app-1': app1Data,
      'demo-app-2': app2Data,
    },
  }
}

/**
 * Get the number of days for demo data based on chart mode.
 * In billing period mode, use the data array length if available.
 * In last-30-days mode, always use 30.
 */
export function getDemoDayCount(useBillingPeriod: boolean, existingDataLength?: number): number {
  if (!useBillingPeriod) {
    // Last 30 days mode always uses 30 data points
    return 30
  }

  // In billing period mode, use existing data length if provided, otherwise default to 30
  return existingDataLength && existingDataLength > 0 ? existingDataLength : 30
}
