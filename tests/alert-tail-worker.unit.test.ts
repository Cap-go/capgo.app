import { describe, expect, it } from 'vitest'
import worker, { AlertThrottle } from '../cloudflare_workers/alert_tail/index.ts'

describe('alert tail worker exports', () => {
  it.concurrent('exports the tail handler and AlertThrottle durable object', () => {
    expect(typeof worker.tail).toBe('function')
    expect(AlertThrottle).toBeTypeOf('function')
  })
})
