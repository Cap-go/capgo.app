export function createTodayLineOptions(input: {
  useBillingPeriod: boolean
  index: number
  labelCount: number
  label: string
  isDark: boolean
}) {
  if (!input.useBillingPeriod || input.index < 0 || input.index >= input.labelCount)
    return { enabled: false as const }

  const strokeColor = input.isDark ? 'rgba(165, 180, 252, 0.75)' : 'rgba(99, 102, 241, 0.7)'
  const glowColor = input.isDark ? 'rgba(129, 140, 248, 0.35)' : 'rgba(165, 180, 252, 0.35)'
  const badgeFill = input.isDark ? 'rgba(67, 56, 202, 0.45)' : 'rgba(199, 210, 254, 0.85)'
  const textColor = input.isDark ? '#e0e7ff' : '#312e81'

  return {
    enabled: true as const,
    xIndex: input.index,
    label: input.label,
    color: strokeColor,
    glowColor,
    badgeFill,
    textColor,
  }
}

/** Skip red/green hues reserved for update success/fail series. */
export function isReservedChartHue(hue: number): boolean {
  return (hue >= 0 && hue <= 30) || (hue >= 330 && hue <= 360) || (hue >= 90 && hue <= 160)
}

export function getSafeChartHue(targetIndex: number): number {
  let i = 0
  let safeCount = 0

  while (safeCount <= targetIndex && i < targetIndex * 3 + 10) {
    const hue = (210 + i * 137.508) % 360
    i++
    if (!isReservedChartHue(hue)) {
      if (safeCount === targetIndex)
        return hue
      safeCount++
    }
  }

  return 210
}

export function generateAppChartColors(appCount: number): string[] {
  const colors: string[] = []
  for (let colorIndex = 0; colorIndex < appCount; colorIndex++) {
    const hue = getSafeChartHue(colorIndex)
    const saturation = 50 + (colorIndex % 3) * 8
    const lightness = 60 + (colorIndex % 4) * 5
    colors.push(`hsla(${hue}, ${saturation}%, ${lightness}%, 0.8)`)
  }
  return colors
}
