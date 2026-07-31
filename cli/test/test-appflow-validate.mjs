import assert from 'node:assert'

const { validateAppleAppPassword } = await import('../src/build/onboarding/ios/validate-app-password.ts')

const ok = await validateAppleAppPassword('a@b.com', 'w-x-y-z', async () => ({ ok: true, json: async () => ({ result: { Success: true } }) }))
assert.strictEqual(ok.valid, true)

const bad = await validateAppleAppPassword('a@b.com', 'bad', async () => ({ ok: true, json: async () => ({ result: { Success: false, ErrorMessage: 'nope', ErrorCode: -20101 } }) }))
assert.strictEqual(bad.valid, false)
assert.strictEqual(bad.message, 'nope')

const net = await validateAppleAppPassword('a@b.com', 'x', async () => { throw new Error('offline') })
assert.strictEqual(net.valid, false) // never throws

// C9: the kind distinguishes authenticated / rejected / unreachable.
assert.strictEqual(ok.kind, 'authenticated')
assert.strictEqual(bad.kind, 'rejected')
assert.strictEqual(net.kind, 'unreachable')

// C4: a very large / control-character ErrorMessage is capped to a single line of
// bounded length so it cannot blow up the validate-results view / MCP summary.
const huge = 'A'.repeat(5000)
const big = await validateAppleAppPassword('a@b.com', 'bad', async () => ({ ok: true, json: async () => ({ result: { Success: false, ErrorMessage: huge } }) }))
assert.ok(big.message.length <= 200, `capped message length ${big.message.length} <= 200`)
assert.ok(big.message.length < huge.length, 'message was actually capped')

const noisy = await validateAppleAppPassword('a@b.com', 'bad', async () => ({ ok: true, json: async () => ({ result: { Success: false, ErrorMessage: 'line1\nline2\tcol\u0007bell' } }) }))
assert.ok(!/[\n\t\u0007]/.test(noisy.message), 'newlines/control chars stripped to single line')
assert.strictEqual(noisy.message, 'line1 line2 col bell')

// Timeout wiring: an AbortSignal is threaded into the fetch (so a stalled call can
// be aborted), and an abort/transport failure stays advisory (kind 'unreachable').
let sawSignal = false
const aborted = await validateAppleAppPassword('a@b.com', 'x', async (_url, opts) => {
  sawSignal = !!(opts && opts.signal instanceof AbortSignal)
  throw new Error('aborted')
})
assert.strictEqual(sawSignal, true, 'an AbortSignal is threaded into the validation fetch')
assert.strictEqual(aborted.valid, false)
assert.strictEqual(aborted.kind, 'unreachable')

console.log('validate app-specific password OK')
