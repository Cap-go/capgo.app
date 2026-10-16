import type { CleanupMessage } from './cleanup.ts'
import type { AlertCounts, AlertReason, CleanupDatabase } from './cleanup_alerts.ts'
import type { CleanupStorage, CleanupStorageDiagnostic, CleanupStorageEnv } from './cleanup_storage.ts'
import { Client } from 'pg'
import { publicationDeadline } from './cleanup.ts'
import { sendCleanupAlert } from './cleanup_alerts.ts'
import { CLEANUP_CONSUMER, completeCleanupGroup, inspectCleanupGroup, parseCleanupMessage } from './cleanup_database.ts'
import { createCleanupStorage } from './cleanup_storage.ts'

export interface CleanupConsumerEnv extends CleanupStorageEnv {
  INVENTORY_BUCKET: string
  HYPERDRIVE_R2_INVENTORY: Hyperdrive
  CLEANUP_DLQ: Queue<unknown>
  R2_CLEANUP_DISCORD_WEBHOOK_URL?: string
}
interface Job { value: CleanupMessage, messages: Message<unknown>[] }
export interface CleanupDependencies {
  database: CleanupDatabase
  storage: (reportFailure?: (diagnostic: CleanupStorageDiagnostic) => void) => CleanupStorage
  now: () => number
}

function dependencies(env: CleanupConsumerEnv): CleanupDependencies {
  return {
    now: Date.now,
    storage: reportFailure => createCleanupStorage(env, reportFailure),
    database: async (work) => {
      const connectionString = env.HYPERDRIVE_R2_INVENTORY?.connectionString
      if (!connectionString)
        throw new Error('Inventory database binding missing')
      const db = new Client({ connectionString, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 2000, lock_timeout: 500, idle_in_transaction_session_timeout: 5000 })
      try {
        await db.connect()
        return await work(db)
      }
      finally {
        await db.end()
      }
    },
  }
}

export async function cleanupWorkflow(storage: CleanupStorage, value: CleanupMessage, etag: string | null, deadline: number, now = Date.now) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        if (now() >= deadline)
          controller.abort()
        controller.signal.throwIfAborted()
        return storage.remove(value.bucket, value.key, etag, controller.signal)
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Cleanup storage deadline exceeded'))
        }, Math.max(0, deadline - now()))
      }),
    ])
    controller.signal.throwIfAborted()
    if (now() >= deadline)
      throw new Error('Cleanup storage deadline exceeded')
  }
  finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function consumeCleanupBatch(batch: MessageBatch<unknown>, env: CleanupConsumerEnv, deps = dependencies(env)) {
  const settled = new Set<Message<unknown>>()
  const counts: AlertCounts = {}
  const storageFailures = new Set<string>()
  const problem = (reason: AlertReason, count = 1) => {
    counts[reason] = (counts[reason] ?? 0) + count
  }
  const ack = (messages: Message<unknown>[]) => {
    for (const message of messages) {
      message.ack()
      settled.add(message)
    }
  }
  const retry = (messages: readonly Message<unknown>[]) => {
    for (const message of messages) {
      if (!settled.has(message)) {
        message.retry({ delaySeconds: 30 })
        settled.add(message)
      }
    }
  }
  const deadline = deps.now() + CLEANUP_CONSUMER.batchMs
  try {
    if (batch.messages.length > 100)
      throw new Error('Cleanup queue batch exceeds bound')
    const jobs = new Map<string, Job>()
    const invalid: { body: unknown, contentType: 'json' | 'v8' }[] = []
    const invalidMessages: Message<unknown>[] = []
    for (const message of batch.messages) {
      try {
        const value = parseCleanupMessage(message.body, env.INVENTORY_BUCKET)
        const identity = JSON.stringify([value.key, value.cleanupRequestedAt])
        const existing = jobs.get(identity)
        if (existing)
          existing.messages.push(message)
        else
          jobs.set(identity, { value, messages: [message] })
      }
      catch {
        const body = { kind: 'invalid_cleanup_message', originalQueue: batch.queue, originalMessageId: message.id, originalTimestamp: message.timestamp.toISOString(), attempts: message.attempts, reason: 'Invalid cleanup identity or scope', body: message.body }
        let contentType: 'json' | 'v8' = 'json'
        try {
          JSON.stringify(body)
        }
        catch {
          contentType = 'v8'
        }
        invalid.push({ body, contentType })
        invalidMessages.push(message)
      }
    }
    if (invalid.length) {
      problem('invalid', invalid.length)
      try {
        await publicationDeadline(() => env.CLEANUP_DLQ.sendBatch(invalid), 3000)
        ack(invalidMessages)
      }
      catch {
        problem('dlq', invalid.length)
        retry(invalidMessages)
      }
    }
    let storage: CleanupStorage | undefined
    const pending = [...jobs.values()]
    for (let offset = 0; offset < pending.length; offset += CLEANUP_CONSUMER.groupSize) {
      if (deps.now() + CLEANUP_CONSUMER.objectMs + CLEANUP_CONSUMER.reserveMs >= deadline) {
        problem('deadline', pending.length - offset)
        break
      }
      const group = pending.slice(offset, offset + CLEANUP_CONSUMER.groupSize)
      try {
        const inspection = await deps.database(db => inspectCleanupGroup(db, env.INVENTORY_BUCKET, group.map(job => job.value)))
        const rows = new Map(inspection.snapshot.rows.map(row => [row.r2_key, row]))
        const completed: string[] = []
        // Same-key jobs with different identities cannot both authorize work.
        // Pick the decision independently; each database inspection still uses
        // the exact retirement identity, never a revision or rounded JS Date.
        for (let start = 0; start < group.length; start += CLEANUP_CONSUMER.concurrency) {
          await Promise.all(group.slice(start, start + CLEANUP_CONSUMER.concurrency).map(async (job) => {
            try {
              const decision = inspection.decisions.get(job.value)
              if (decision === 'retry' || !decision) {
                retry(job.messages)
                return
              }
              if (decision !== 'remove') {
                if (decision === 'referenced' || decision === 'leased')
                  problem(decision)
                ack(job.messages)
                return
              }
              const until = Math.min(deadline - CLEANUP_CONSUMER.reserveMs, inspection.healthUntil, Date.parse(inspection.snapshot.startedAt) + 110_000)
              if (deps.now() + CLEANUP_CONSUMER.objectMs > until) {
                problem('deadline')
                retry(job.messages)
                return
              }
              storage ??= deps.storage((diagnostic) => {
                const identity = JSON.stringify([diagnostic.stage, diagnostic.errorType, diagnostic.httpStatus, diagnostic.hasCopyResult, diagnostic.hasCopyEtag, diagnostic.hasCopyLastModified])
                if (storageFailures.size < 3 && !storageFailures.has(identity)) {
                  storageFailures.add(identity)
                  console.log(JSON.stringify({ event: 'r2_cleanup_storage_failure', ...diagnostic }))
                }
              })
              await cleanupWorkflow(storage, job.value, rows.get(job.value.key)?.etag ?? null, Math.min(deps.now() + CLEANUP_CONSUMER.objectMs, until), deps.now)
              // Storage success is final for queue delivery. ACK precedes every
              // completion query; post-ACK bookkeeping can never retry this job.
              ack(job.messages)
              completed.push(job.value.key)
            }
            catch {
              problem('storage')
              retry(job.messages)
            }
          }))
        }
        if (completed.length) {
          try {
            const conflicts = await deps.database(db => completeCleanupGroup(db, env.INVENTORY_BUCKET, inspection.snapshot, completed))
            if (conflicts.length)
              problem('conflict', conflicts.length)
          }
          catch {
            problem('completion')
          }
        }
      }
      catch {
        problem('safety', group.length)
        retry(group.flatMap(job => job.messages))
      }
    }
  }
  catch {
    problem('safety')
  }
  finally {
    // Never use retryAll: it would erase successful per-message isolation.
    retry(batch.messages)
    await sendCleanupAlert(deps.database, env.INVENTORY_BUCKET, env.R2_CLEANUP_DISCORD_WEBHOOK_URL, counts)
    console.log(JSON.stringify({ event: 'r2_cleanup_batch', received: batch.messages.length, counts }))
  }
}
