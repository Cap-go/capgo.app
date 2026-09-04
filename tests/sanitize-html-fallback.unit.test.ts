import { describe, expect, it } from 'vitest'

describe('sanitizeHtml node fallback', () => {
  it.concurrent('strips tags when DOM APIs are unavailable', async () => {
    const originalWindow = globalThis.window
    // @ts-expect-error test override
    delete globalThis.window

    try {
      const { sanitizeHtml } = await import('../src/utils/sanitize.ts')
      expect(sanitizeHtml('<p>Hello<script>alert(1)</script></p>'))
        .toBe('&lt;p&gt;Hello&lt;script&gt;alert(1)&lt;/script&gt;&lt;/p&gt;')
      expect(sanitizeHtml('<<script>alert(1)//'))
        .toBe('&lt;&lt;script&gt;alert(1)//')
    }
    finally {
      globalThis.window = originalWindow
    }
  })
})
