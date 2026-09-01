import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('admin plugins dashboard layout', () => {
  it.concurrent('uses the existing funnel chart height box for compatibility stacked bars', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/plugins.vue', import.meta.url), 'utf8')

    const selfStoreChartCard = source.match(/chart-id="channel-self-store-compatibility"[\s\S]*?<\/ChartCard>/)?.[0] ?? ''
    const encryptionChartCard = source.match(/chart-id="encryption-key-id-compatibility"[\s\S]*?<\/ChartCard>/)?.[0] ?? ''

    expect(selfStoreChartCard).toContain('class="h-72 sm:h-80"')
    expect(selfStoreChartCard).toContain('<AdminStackedBarChart')
    expect(selfStoreChartCard).toContain('<AdminStatsCard')
    expect(encryptionChartCard).toContain('class="h-72 sm:h-80"')
    expect(encryptionChartCard).toContain('<AdminStackedBarChart')
    expect(encryptionChartCard).toContain('<AdminStatsCard')
  })

  it.concurrent('falls back to the latest non-empty trend point for snapshot charts', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/plugins.vue', import.meta.url), 'utf8')

    expect(source).toContain('getLatestNonEmptyPluginTrendPoint')
    expect(source).toContain('const latestSnapshotPoint = computed')
    expect(source).toContain('populatedVersionTrendPoints')
    expect(source).toContain('populatedMajorTrendPoints')
    expect(source).not.toContain('resolvePluginBreakdownSnapshot')
    expect(source).not.toContain('chart-height')
    expect(source).not.toContain('ADMIN_PLUGINS_CHART_HEIGHT_PX')
  })
})
