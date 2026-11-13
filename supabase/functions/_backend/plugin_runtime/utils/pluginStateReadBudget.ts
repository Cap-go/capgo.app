import type { Context } from 'hono'
import { PluginStateMiss } from './pluginStateRegistry.ts'

/** Bound document work even when a public batch contains arbitrary keys. */
export const MAX_PLUGIN_STATE_DOCUMENTS = 16
export const PLUGIN_STATE_READ_CONCURRENCY = 4

interface ReadBudget {
  keys: Set<string>
  active: number
  waiting: Array<() => void>
  exhausted: boolean
}

const budgets = new WeakMap<Request, ReadBudget>()

/** Limit both cache lookups and provider fanout for one device request. */
export async function withPluginStateDocument<T>(c: Context, key: string, load: () => Promise<T>): Promise<T> {
  let budget = budgets.get(c.req.raw)
  if (!budget) {
    budget = { keys: new Set(), active: 0, waiting: [], exhausted: false }
    budgets.set(c.req.raw, budget)
  }
  if (!budget.keys.has(key)) {
    if (budget.keys.size >= MAX_PLUGIN_STATE_DOCUMENTS) {
      budget.exhausted = true
      for (const resume of budget.waiting.splice(0))
        resume()
    }
    else {
      budget.keys.add(key)
    }
  }
  if (budget.exhausted)
    throw new PluginStateMiss('document read budget exhausted')
  if (budget.active >= PLUGIN_STATE_READ_CONCURRENCY) {
    await new Promise<void>(resolve => budget.waiting.push(resolve))
    if (budget.exhausted)
      throw new PluginStateMiss('document read budget exhausted')
  }
  else {
    budget.active++
  }
  try {
    return await load()
  }
  finally {
    const resume = budget.waiting.shift()
    if (resume)
      resume()
    else
      budget.active--
  }
}
