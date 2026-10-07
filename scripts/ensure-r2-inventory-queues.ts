import { spawnSync } from 'node:child_process'

const env = process.argv[2]
if (!['alpha', 'preprod', 'prod'].includes(env))
  throw new Error('Usage: bun scripts/ensure-r2-inventory-queues.ts <alpha|preprod|prod>')
for (const suffix of ['', '-dlq', '-repair', '-repair-dlq']) {
  const name = `capgo-r2-inventory-${env}${suffix}`
  const result = spawnSync('bunx', ['wrangler', 'queues', 'create', name, '--message-retention-period-secs', '345600'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status !== 0 && !/already exists|already been taken/i.test(output))
    throw new Error(output.trim() || `Unable to create ${name}`)
  console.log(`${name}: ${result.status === 0 ? 'created' : 'already exists; verify retention is 4 days'}`)
}
