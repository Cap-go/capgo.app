import { availableParallelism, cpus } from 'node:os'

/** CPU-bound work (Brotli, AES, SHA-256) gains nothing past the core count. */
export function defaultCpuConcurrency(max = 16): number {
  let count = 1
  try {
    count = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
  }
  catch {
    count = 1
  }
  return Math.max(1, Math.min(max, Number.isFinite(count) ? count : 1))
}

/**
 * Runs `task` for every index in [0, count) with at most `concurrency` tasks in
 * flight. A worker picks the next index as soon as it is free, so one slow task
 * never holds back the others (unlike fixed `Promise.all` batches).
 *
 * The first failure stops new tasks from starting. The returned promise rejects
 * with that first error only once every running task has settled, so caller
 * cleanup (e.g. disposing the delta payload cache) never races a task that is
 * still in flight.
 */
export function runWorkerPool<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = Array.from({ length: count })
  if (count <= 0)
    return Promise.resolve(results)
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, count))

  return new Promise<T[]>((resolve, reject) => {
    let nextIndex = 0
    let active = 0
    let completed = 0
    let failed = false
    let firstError: unknown

    const settle = () => {
      if (failed) {
        if (active === 0)
          reject(firstError)
        return
      }
      if (completed === count)
        resolve(results)
      else
        launch()
    }

    const launch = () => {
      while (!failed && active < limit && nextIndex < count) {
        const index = nextIndex++
        active++
        let promise: Promise<T>
        try {
          promise = Promise.resolve(task(index))
        }
        catch (error) {
          promise = Promise.reject(error)
        }
        promise.then((value) => {
          results[index] = value
          active--
          completed++
          settle()
        }, (error) => {
          active--
          if (!failed) {
            failed = true
            firstError = error
          }
          settle()
        })
      }
    }

    launch()
  })
}
