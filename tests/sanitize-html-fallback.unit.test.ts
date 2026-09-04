import { describe, expect, it } from 'vitest'

describe('sanitizeHtml node fallback', () => {
  it.concurrent('strips tags when DOM APIs are unavailable', async () => {
    const originalWindow = globalThis.window
    // @ts-expect-error test override
    delete globalThis.window

    try {
      const { sanitizeHtml } = await import('../src/utils/sanitize.ts')
      expect(sanitizeHtml('<p>Hello<script>alert(1)</script></p>')).toBe('Helloalert(1)')
    }
    finally {
      globalThis.window = originalWindow
    }
  })
})
