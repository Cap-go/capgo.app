// src/build/cwd.ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { chdir, cwd } from 'node:process'
import { appendInternalLog } from '../support/internal-log.js'

/**
 * Single in-process queue guarding `process.chdir()`. Both `build request`
 * and MCP tool calls must share this queue: two independent
 * queues over the same global cwd can interleave under concurrent SDK/MCP
 * usage and resolve config against the wrong directory.
 */
const cwdQueue = { pending: Promise.resolve<unknown>(undefined) }
const cwdScope = new AsyncLocalStorage<{ pending: Promise<unknown>, active: boolean }>()

/**
 * Run an async function with the process working directory temporarily set to `dir`.
 *
 * NOTE: `process.chdir()` is global, so this uses a simple in-process queue to avoid
 * concurrent calls interfering with each other.
 */
export async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const parent = cwdScope.getStore()
  const queue = parent?.active ? parent : cwdQueue
  const run = async () => {
    const previous = cwd()
    try {
      chdir(dir)
    }
    catch (error) {
      throw new Error(`Failed to change working directory to "${dir}": ${(error as Error).message}`)
    }

    const scope = { pending: Promise.resolve<unknown>(undefined), active: true }
    return cwdScope.run(scope, async () => {
      try {
        return await fn()
      }
      finally {
        await scope.pending
        scope.active = false
        try {
          chdir(previous)
        }
        catch (err) {
          appendInternalLog(`cwd restore failed (ignored): ${err instanceof Error ? err.message : String(err)}`)
          // Best-effort restore; ignore to avoid masking original errors.
        }
      }
    })
  }

  const result = queue.pending.then(run, run)
  queue.pending = result.then(() => undefined, () => undefined)
  return result
}
