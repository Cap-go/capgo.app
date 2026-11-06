import { describe, expect, it } from 'vitest'

import { getDatabaseURL } from '../supabase/functions/_backend/utils/pg.ts'

async function consumedResponse() {
  const res = new Response('ok')
  await res.text() // mark bodyUsed=true
  return res
}

function lockedResponse() {
  const res = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('ok'))
      controller.close()
    },
  }))
  // Lock the response body as if the runtime started streaming it already.
  res.body?.getReader()
  return res
}

describe('getDatabaseURL header safety', () => {
  it.concurrent.each([
    ['response body was already consumed', consumedResponse],
    ['response body stream is locked', lockedResponse],
  ] as const)('does not try to mutate headers when %s', async (_name, makeResponse) => {
    let headerCalls = 0
    const ctx = {
      res: await makeResponse(),
      env: {
        // Provide a deterministic code path that doesn't depend on host env vars.
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' },
        // Included to satisfy environments where `getEnv()` might read from `c.env`.
        SUPABASE_DB_URL: 'postgres://postgres:postgres@localhost:5432/postgres',
      },
      header: () => {
        headerCalls++
        throw new TypeError('This ReadableStream is disturbed (has already been read from), and cannot be used as a body.')
      },
      get: (key: string) => (key === 'requestId' ? 'test-request' : undefined),
      set: () => {},
    } as any

    expect(() => getDatabaseURL(ctx)).not.toThrow()
    expect(headerCalls).toBe(0)
  })
})
