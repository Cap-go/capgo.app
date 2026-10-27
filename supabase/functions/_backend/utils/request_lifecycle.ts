import type { Context } from 'hono'

// No imports on purpose: utils/hono.ts calls this, and modules that hold
// per-request resources (utils/db.ts) register here without an import cycle.
const finishers: Array<(c: Context) => void> = []

export function onRequestFinished(finisher: (c: Context) => void) {
  finishers.push(finisher)
}

export function finishRequest(c: Context) {
  for (const finisher of finishers) {
    try {
      finisher(c)
    }
    catch {
      // A cleanup failure must not replace the response.
    }
  }
}
