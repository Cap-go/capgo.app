import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('admin plugins dashboard layout', () => {
  it.concurrent('keeps compatibility stats outside the ChartCard chart body', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/plugins.vue', import.meta.url), 'utf8')

    const selfStoreChartCard = source.match(/chart-id="channel-self-store-compatibility"[\s\S]*?<\/ChartCard>/)?.[0] ?? ''
    const encryptionChartCard = source.match(/chart-id="encryption-key-id-compatibility"[\s\S]*?<\/ChartCard>/)?.[0] ?? ''

    expect(selfStoreChartCard).toContain('role="group"')
    expect(selfStoreChartCard).toContain('class="h-full"')
    expect(selfStoreChartCard).not.toContain('<AdminStatsCard')
    expect(encryptionChartCard).toContain('role="group"')
    expect(encryptionChartCard).toContain('class="h-full"')
    expect(encryptionChartCard).not.toContain('<AdminStatsCard')
  })

  it.concurrent('falls back to the latest non-empty trend point for snapshot charts', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/plugins.vue', import.meta.url), 'utf8')

    expect(source).toContain('getLatestNonEmptyPluginTrendPoint')
    expect(source).toContain('const latestSnapshotPoint = computed')
    expect(source).toContain('populatedVersionTrendPoints')
    expect(source).not.toContain('resolvePluginBreakdownSnapshot')
    expect(source).not.toContain('chart-height')
    expect(source).not.toContain('ADMIN_PLUGINS_CHART_HEIGHT_PX')
  })
})
