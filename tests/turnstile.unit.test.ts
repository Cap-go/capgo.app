import { describe, expect, it, vi } from 'vitest'
import { safeResetTurnstile } from '../src/utils/turnstile.ts'

describe('safeResetTurnstile', () => {
  it('calls reset when the component is present', () => {
    const reset = vi.fn()
    safeResetTurnstile({ reset })
    expect(reset).toHaveBeenCalledOnce()
  })

  it('no-ops when the component ref is null', () => {
    expect(() => safeResetTurnstile(null)).not.toThrow()
  })

  it('swallows Turnstile reset errors when the container is gone', () => {
    const reset = vi.fn(() => {
      throw new Error('[Cloudflare Turnstile] Nothing to reset found for provided container.')
    })

    expect(() => safeResetTurnstile({ reset })).not.toThrow()
    expect(reset).toHaveBeenCalledOnce()
  })
})
