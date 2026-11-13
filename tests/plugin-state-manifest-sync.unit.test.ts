import { describe, expect, it } from 'vitest'
import { syncPluginStateManifestPage } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'

/** The provider binding is external to Vitest. Exercise the real continuation
 * helper with a lightweight writer that enforces the production operation cap. */
describe('plugin state manifest sync continuation', () => {
  it.concurrent('finishes more than 800 served manifests across bounded invocations', async () => {
    const targets = Array.from({ length: 1001 }, (_, index) => 1001 - index)
    const written = new Map<number, number>()
    const invocations: number[] = []
    let after: number | null = null
    let done = false
    for (let invocation = 0; invocation < 4 && !done; invocation++) {
      let operations = 0
      while (operations < 800 && !done) {
        const progress = await syncPluginStateManifestPage({
          versionIds: targets,
          after,
          deadline: Date.now() + 10_000,
          available: () => 800 - operations,
          write: async (ids) => {
            for (const id of ids) {
              operations++
              if (operations > 800)
                throw new Error('provider operation limit exceeded')
              written.set(id, (written.get(id) ?? 0) + 1)
            }
          },
        })
        expect(progress.done || progress.after !== after).toBe(true)
        after = progress.after
        done = progress.done
      }
      invocations.push(operations)
    }
    expect(done).toBe(true)
    expect(invocations).toEqual([800, 201])
    expect([...written.keys()].sort((a, b) => a - b)).toEqual([...targets].sort((a, b) => a - b))
    expect([...written.values()].every(count => count === 1)).toBe(true)
  })

  it.concurrent('retains its cursor when capacity or the deadline stops a pass', async () => {
    let writes = 0
    for (const stop of ['capacity', 'deadline']) {
      const progress = await syncPluginStateManifestPage({
        versionIds: [1, 2, 3, 4],
        after: 2,
        deadline: stop === 'deadline' ? Date.now() - 1 : Date.now() + 10_000,
        available: () => stop === 'capacity' ? 0 : 800,
        write: async () => { writes++ },
      })
      expect(progress).toEqual({ after: 2, done: false })
    }
    expect(writes).toBe(0)
  })
})
