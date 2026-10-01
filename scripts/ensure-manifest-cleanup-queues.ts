import { spawnSync } from 'node:child_process'

type QueueEnv = 'alpha' | 'preprod' | 'prod'

const queueNames: Record<QueueEnv, string[]> = {
  alpha: ['capgo-manifest-cleanup-alpha', 'capgo-manifest-cleanup-alpha-dlq'],
  preprod: ['capgo-manifest-cleanup-preprod', 'capgo-manifest-cleanup-preprod-dlq'],
  prod: ['capgo-manifest-cleanup-prod', 'capgo-manifest-cleanup-prod-dlq'],
}

function selectedEnvs(): QueueEnv[] {
  const selected = process.argv[2] || 'all'
  if (selected === 'all')
    return ['alpha', 'preprod', 'prod']
  if (selected === 'alpha' || selected === 'preprod' || selected === 'prod')
    return [selected]
  throw new Error('Usage: bun scripts/ensure-manifest-cleanup-queues.ts [alpha|preprod|prod|all]')
}

function createQueue(name: string) {
  const result = spawnSync('bunx', ['wrangler', 'queues', 'create', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

  if (result.status === 0) {
    process.stdout.write(output)
    return
  }

  if (/already exists|already been taken|10013|10016/i.test(output)) {
    console.log(`Queue already exists: ${name}`)
    return
  }

  throw new Error(output.trim() || `Unable to create queue ${name}`)
}

for (const env of selectedEnvs()) {
  console.log(`Ensuring manifest cleanup queues for ${env}`)
  for (const name of queueNames[env])
    createQueue(name)
}
