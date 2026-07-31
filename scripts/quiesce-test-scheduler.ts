import process from 'node:process'
import { Client } from 'pg'

interface CronJobRow {
  jobid: number
}

interface QueueRow {
  queue_name: string
}

const connectionString = process.env.SUPABASE_DB_URL
if (!connectionString)
  throw new Error('SUPABASE_DB_URL is required to quiesce the test scheduler')

const client = new Client({ connectionString })
let lockHeld = false
let purgedQueueCount = 0

try {
  await client.connect()
  // Use the same lock as process_all_cron_tasks to establish a stable test boundary.
  await client.query('SELECT pg_advisory_lock($1::bigint)', [1])
  lockHeld = true

  const scheduledJobs = await client.query<CronJobRow>(
    'SELECT jobid FROM cron.job WHERE jobname = $1',
    ['process_all_cron_tasks'],
  )
  if (scheduledJobs.rows.length > 1)
    throw new Error(`Expected at most one process_all_cron_tasks scheduler job, found ${scheduledJobs.rows.length}`)

  if (scheduledJobs.rows.length === 1) {
    const { rows: unscheduledRows } = await client.query<{ unscheduled: boolean }>(
      'SELECT cron.unschedule($1::text) AS unscheduled',
      ['process_all_cron_tasks'],
    )
    if (!unscheduledRows[0]?.unscheduled)
      throw new Error('Could not unschedule process_all_cron_tasks')
  }

  // Wait for a pg_net worker already handling seeded scheduler work, then remove queued callbacks.
  // Deleting rows would not synchronize with an active pg_net batch.
  await client.query('TRUNCATE TABLE net.http_request_queue')

  const { rows: queues } = await client.query<QueueRow>(
    'SELECT q.queue_name FROM pgmq.list_queues() AS q',
  )
  for (const { queue_name } of queues) {
    await client.query('SELECT pgmq.purge_queue($1::text)', [queue_name])
    purgedQueueCount++
  }

  const { rows: remainingJobs } = await client.query<CronJobRow>(
    'SELECT jobid FROM cron.job WHERE jobname = $1',
    ['process_all_cron_tasks'],
  )
  if (remainingJobs.length !== 0)
    throw new Error('process_all_cron_tasks is still scheduled')

  console.log(`Quiesced test scheduler and purged ${purgedQueueCount} queues`)
}
finally {
  try {
    if (lockHeld)
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [1])
  }
  finally {
    await client.end()
  }
}
