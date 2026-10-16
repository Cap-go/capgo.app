import type { DispatchJob, Evaluation } from './contracts.ts'
import type { DispatchStore } from './store.ts'

export async function publishDispatchJobs(queue: Pick<Queue<DispatchJob>, 'send'>, store: Pick<DispatchStore, 'schedule' | 'markEnqueued' | 'publicationFailed'>, registry: Record<string, Evaluation>) {
  let failed = false
  // Independent evaluations each take their own short durable scheduling claim.
  for (const evaluation of Object.values(registry)) {
    try {
      const run = await store.schedule(evaluation.key, evaluation.everyMinutes)
      if (!run)
        continue
      try {
        await queue.send({ version: 1, evaluationKey: evaluation.key, runId: run.id })
        await store.markEnqueued(run.id, run.enqueue_claim_token!)
      }
      catch {
        await store.publicationFailed(run.id, run.enqueue_claim_token!)
        failed = true
      }
    }
    catch { failed = true }
  }
  if (failed)
    throw new Error('Queue publication failed')
}
