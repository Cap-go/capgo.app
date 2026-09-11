export interface AdminABTestDistributionBranch {
  branch: string
  count: number
  label: string
  percentage: number
}

export interface AdminABTestDistribution {
  branches: AdminABTestDistributionBranch[]
  label: string
  test_name: string
  total: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function expectedPercentage(count: number, total: number): number {
  if (total === 0)
    return 0
  return Math.round((count / total) * 1_000) / 10
}

function parseBranch(value: unknown): AdminABTestDistributionBranch | null {
  if (!isRecord(value)
    || typeof value.branch !== 'string'
    || !value.branch
    || typeof value.label !== 'string'
    || !value.label
    || !isNonNegativeInteger(value.count)
    || !isPercentage(value.percentage)) {
    return null
  }

  return {
    branch: value.branch,
    count: value.count,
    label: value.label,
    percentage: value.percentage,
  }
}

export function parseAdminABTestDistribution(value: unknown): AdminABTestDistribution[] | null {
  if (!Array.isArray(value))
    return null

  const result: AdminABTestDistribution[] = []
  const testNames = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.test_name !== 'string'
      || !item.test_name
      || testNames.has(item.test_name)
      || typeof item.label !== 'string'
      || !item.label
      || !isNonNegativeInteger(item.total)
      || !Array.isArray(item.branches)
      || item.branches.length !== 2) {
      return null
    }

    const branches = item.branches.map(parseBranch)
    if (branches.includes(null))
      return null
    const total = item.total
    const parsedBranches = branches as AdminABTestDistributionBranch[]
    if (new Set(parsedBranches.map(branch => branch.branch)).size !== parsedBranches.length
      || parsedBranches.reduce((sum, branch) => sum + branch.count, 0) !== total
      || parsedBranches.some(branch => branch.percentage !== expectedPercentage(branch.count, total))) {
      return null
    }

    testNames.add(item.test_name)
    result.push({
      branches: parsedBranches,
      label: item.label,
      test_name: item.test_name,
      total,
    })
  }

  return result
}

export function totalABTestAssignments(distribution: AdminABTestDistribution[]): number {
  return distribution.reduce((sum, test) => sum + test.total, 0)
}
