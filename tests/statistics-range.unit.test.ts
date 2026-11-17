import { describe, expect, it } from 'vitest'
import { listTools } from '../supabase/functions/_backend/mcp/protocol.ts'
import { MCP_TOOLS_BY_NAME } from '../supabase/functions/_backend/mcp/tools.ts'
import { isStatisticsRangeTooLarge, MAX_STATISTICS_RANGE_DAYS, statisticsRangeDays } from '../supabase/functions/_backend/utils/statistics_range.ts'

const STATS_TOOLS = [
  'capgo_get_app_statistics',
  'capgo_get_organization_statistics',
  'capgo_get_account_statistics',
  'capgo_get_bundle_usage',
  'capgo_get_native_usage',
] as const

function toolInput(name: typeof STATS_TOOLS[number], from: string, to: string) {
  if (name === 'capgo_get_organization_statistics')
    return { orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', from, to }
  if (name === 'capgo_get_account_statistics')
    return { from, to }
  return { appId: 'com.demo.app', from, to }
}

describe('statistics date range limit', () => {
  it.concurrent('counts graph days like the statistics endpoints', () => {
    expect(statisticsRangeDays(new Date('2026-01-01'), new Date('2026-01-31'))).toBe(30)
    expect(statisticsRangeDays(new Date('2026-01-31'), new Date('2026-01-01'))).toBe(30)
    expect(statisticsRangeDays(new Date('2000-01-01'), new Date('2026-01-01'))).toBe(9497)
  })

  it.concurrent('accepts a yearly billing period and rejects anything over the cap', () => {
    // A leap-year billing period (366 days) plus the exclusive next-midnight end the console sends.
    expect(isStatisticsRangeTooLarge(new Date('2027-11-16T00:00:00Z'), new Date('2028-11-17T00:00:00Z'))).toBe(false)
    const from = new Date('2026-01-01T00:00:00Z')
    const atCap = new Date(from.getTime() + MAX_STATISTICS_RANGE_DAYS * 86_400_000)
    const overCap = new Date(from.getTime() + (MAX_STATISTICS_RANGE_DAYS + 1) * 86_400_000)
    expect(isStatisticsRangeTooLarge(from, atCap)).toBe(false)
    expect(isStatisticsRangeTooLarge(from, overCap)).toBe(true)
    expect(isStatisticsRangeTooLarge(new Date('2000-01-01'), new Date('2026-01-01'))).toBe(true)
  })

  it.concurrent.each(STATS_TOOLS)('%s rejects ranges over the cap in its input schema', (name) => {
    const tool = MCP_TOOLS_BY_NAME.get(name)!
    expect(tool.inputSchema.safeParse(toolInput(name, '2026-01-01', '2026-12-31')).success).toBe(true)

    const tooLong = tool.inputSchema.safeParse(toolInput(name, '2000-01-01', '2026-01-01'))
    expect(tooLong.success).toBe(false)
    expect(tooLong.error?.issues[0]?.path).toEqual(['to'])
    expect(tooLong.error?.issues[0]?.message).toContain(`${MAX_STATISTICS_RANGE_DAYS} days`)

    // Unparseable dates are left for the endpoint to report.
    expect(tool.inputSchema.safeParse(toolInput(name, 'yesterday', '2026-01-01')).success).toBe(true)
  })

  it.concurrent('keeps the statistics tools listed with their date fields', () => {
    const tools = listTools() as { name: string, inputSchema: { properties?: Record<string, unknown> } }[]
    for (const name of STATS_TOOLS) {
      const tool = tools.find(entry => entry.name === name)
      expect(tool?.inputSchema.properties).toHaveProperty('from')
      expect(tool?.inputSchema.properties).toHaveProperty('to')
    }
  })
})
