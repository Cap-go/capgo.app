import { spawnSync } from 'node:child_process'

type QueueEnv = 'alpha' | 'preprod' | 'prod'

const queueNames: Record<QueueEnv, string[]> = {
  alpha: [
    'capgo-native-notifications-alpha',
    'capgo-native-notifications-alpha-dlq',
  ],
  preprod: [
    'capgo-native-notifications-preprod',
    'capgo-native-notifications-preprod-dlq',
  ],
  prod: [
    'capgo-native-notifications-prod',
    'capgo-native-notifications-prod-dlq',
  ],
}

function selectedEnvs(): QueueEnv[] {
  const arg = process.argv[2] || 'all'
  if (arg === 'all')
    return ['alpha', 'preprod', 'prod']
  if (arg === 'alpha' || arg === 'preprod' || arg === 'prod')
    return [arg]
  throw new Error('Usage: bun scripts/ensure-native-notification-queues.ts [alpha|preprod|prod|all]')
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
  console.log(`Ensuring native notification queues for ${env}`)
  for (const name of queueNames[env])
    createQueue(name)
}
