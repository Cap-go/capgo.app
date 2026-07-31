#!/usr/bin/env bun
import {
  lintAnalyticsEngineSql,
  prepareAnalyticsEngineSqlForLiveValidation,
  validateAnalyticsEngineSqlLive,
} from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import { collectAnalyticsEngineSqlFixtures } from '../tests/helpers/collectAnalyticsEngineSqlFixtures.ts'

const accountId = process.env.CF_ACCOUNT_ANALYTICS_ID
const token = process.env.CF_ANALYTICS_TOKEN

if (!accountId || !token) {
  console.error('Missing CF_ACCOUNT_ANALYTICS_ID or CF_ANALYTICS_TOKEN')
  process.exit(1)
}

const fixtures = await collectAnalyticsEngineSqlFixtures()
const lintFailures = fixtures.flatMap((fixture) => {
  return lintAnalyticsEngineSql(fixture.query).map(issue => `${fixture.name}: ${issue.rule} - ${issue.message}`)
})

if (lintFailures.length > 0) {
  console.error('Static Analytics Engine SQL lint failures:')
  for (const failure of lintFailures)
    console.error(`- ${failure}`)
  process.exit(1)
}

const liveFailures: string[] = []

for (const fixture of fixtures) {
  const prepared = prepareAnalyticsEngineSqlForLiveValidation(fixture.query)
  if (!prepared)
    continue

  const result = await validateAnalyticsEngineSqlLive(accountId, token, fixture.query, prepared)
  if (!result.ok)
    liveFailures.push(`${fixture.name} (${result.status}): ${result.body.trim()}`)
}

if (liveFailures.length > 0) {
  console.error('Live Analytics Engine SQL validation failures:')
  for (const failure of liveFailures)
    console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Validated ${fixtures.length} Analytics Engine SQL queries against Cloudflare`)
