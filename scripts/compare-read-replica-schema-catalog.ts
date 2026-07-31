import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { readReplicaSchemaCompatibilityIssues } from '../read_replicate/schema_compatibility.ts'

const [expectedPath, actualPath] = process.argv.slice(2)

async function main() {
  if (!expectedPath || !actualPath) {
    console.error('Usage: bun scripts/compare-read-replica-schema-catalog.ts <expected-json> <actual-json>')
    process.exitCode = 1
    return
  }

  const expected = JSON.parse(await readFile(expectedPath, 'utf8'))
  const actual = JSON.parse(await readFile(actualPath, 'utf8'))
  const issues = readReplicaSchemaCompatibilityIssues(expected, actual)

  if (!issues.length) {
    console.log('Read-replica selected schema matches the committed snapshot.')
    return
  }

  console.error('::error title=Read-replica schema differs::The selected read-replica schema differs from read_replicate/schema_replicate.catalog.json.')
  console.error('')
  console.error('The selected contract checks table shape, columns, primary/unique/check constraints, indexes, types, sequence definitions, and selected function definitions.')
  console.error('Foreign keys, triggers, RLS policies, and runtime sequence values are intentionally outside this read-only replica contract.')
  console.error('')
  console.error('Incompatible objects:')
  for (const issue of issues)
    console.error(`- ${issue.kind} ${issue.object}: ${issue.reason}`)
  process.exitCode = 1
}

await main()
