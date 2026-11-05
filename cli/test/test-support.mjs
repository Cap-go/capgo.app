// Support feature: internal log, secret redaction, mailto, help menu, bundle files,
// contact flow and the pre-AI upload gate. internal-log runs first so its
// null-before-start contract sees fresh module state.
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { renderBundleWithinGzCap, writeSupportBundleFiles } from '../src/onboarding-support.ts'
import { contactSupport, resetSupportUploadCacheForTests } from '../src/support/contact-support.ts'
import { buildHelpMenuOptions } from '../src/support/help-menu.ts'
import { appendInternalLog, getInternalLogPath, safeHeaders, startInternalLog } from '../src/support/internal-log.ts'
import { buildMailtoUrl, MAILTO_BODY_MAX } from '../src/support/mailto.ts'
import { redactSecrets } from '../src/support/redact.ts'
import { offerSupportUploadBeforeAi, SUPPORT_UPLOAD_PROMPT, supportUploadConfirmation } from '../src/support/support-upload-prompt.ts'

function t(name, fn) {
  try { fn(); process.stdout.write(`✓ ${name}\n`) }
  catch (e) { process.stderr.write(`✗ ${name}\n`); throw e }
}

async function ta(name, fn) {
  try { await fn(); process.stdout.write(`✓ ${name}\n`) }
  catch (e) { process.stderr.write(`✗ ${name}\n`); throw e }
}

// ── internal-log ──
// Runs before any startInternalLog call so the null-before-start contract is
// actually exercised (module state is per-process).
t('getInternalLogPath returns null before start', () => {
  assert.equal(getInternalLogPath(), null)
})

t('writes redacted lines to the log file', () => {
  const dir = join(tmpdir(), `capgo-ilog-${Date.now()}`)
  const path = startInternalLog('com.example.app', dir)
  assert.ok(path)
  appendInternalLog('normal line')
  appendInternalLog('Authorization: Bearer SECRETTOKEN123')
  const content = readFileSync(path, 'utf8')
  assert.ok(content.includes('normal line'))
  assert.ok(!content.includes('SECRETTOKEN123'))
  assert.ok(content.includes('[REDACTED]'))
  rmSync(dir, { recursive: true, force: true })
})

t('safeHeaders logs useful response headers but never sensitive ones', () => {
  const headers = new Headers({
    'date': 'Mon, 08 Jun 2026 10:37:08 GMT',
    'x-request-id': 'req-abc123',
    'x-ratelimit-remaining': '42',
    'content-type': 'application/json',
    // sensitive — must NOT appear:
    'set-cookie': 'session=topsecret',
    'authorization': 'Bearer SHOULD_NEVER_LOG',
    'www-authenticate': 'Bearer error="invalid_token"',
  })
  const out = safeHeaders(headers)
  assert.ok(out.includes('date=Mon, 08 Jun 2026 10:37:08 GMT')) // clock-skew signal
  assert.ok(out.includes('x-request-id=req-abc123')) // escalation handle
  assert.ok(out.includes('x-ratelimit-remaining=42'))
  assert.ok(out.includes('www-authenticate=Bearer error="invalid_token"')) // auth-failure detail (not a secret)
  assert.ok(!out.includes('topsecret')) // set-cookie excluded
  assert.ok(!out.includes('SHOULD_NEVER_LOG')) // request auth header never logged
})

// ── redact ──
t('redacts bearer tokens', () => {
  const out = redactSecrets('Authorization: Bearer abc123DEF456ghi789')
  assert.ok(!out.includes('abc123DEF456ghi789'))
  assert.ok(out.includes('[REDACTED]'))
})

t('redacts capgo api keys (capgkey/capg_ prefixes)', () => {
  const out = redactSecrets('using key capg_1234567890abcdef and capgkey=zzzzzzzzzzzz')
  assert.ok(!out.includes('capg_1234567890abcdef'))
  assert.ok(!out.includes('zzzzzzzzzzzz'))
})

t('redacts PEM private key blocks', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\nDEF==\n-----END PRIVATE KEY-----'
  const out = redactSecrets(`key:\n${pem}\ndone`)
  assert.ok(out.includes('done'))
  assert.ok(!out.includes('MIIabc'))
  assert.ok(out.includes('[REDACTED PRIVATE KEY]'))
})

t('leaves ordinary text untouched', () => {
  assert.equal(redactSecrets('Build failed at step signing'), 'Build failed at step signing')
})

t('redacts JSON-style secrets from raw API error bodies', () => {
  const out = redactSecrets('{"error":"invalid","access_token":"ya29.SECRETVALUE123","detail":"x"}')
  assert.ok(!out.includes('ya29.SECRETVALUE123'))
  assert.ok(out.includes('[REDACTED]'))
  assert.ok(out.includes('"detail":"x"')) // non-secret fields preserved
})

t('redacts p8/pem-keyed values (ASC helper log props) but keeps p8Path', () => {
  const out = redactSecrets('asc-helper error: bad key {"p8":"PRIVKEYBASE64SECRET","pem":"PEMSECRET","p8Path":"/Users/x/AuthKey_ABC.p8","attempt":2}')
  assert.ok(!out.includes('PRIVKEYBASE64SECRET'))
  assert.ok(!out.includes('PEMSECRET'))
  assert.ok(out.includes('/Users/x/AuthKey_ABC.p8'), 'the .p8 file PATH is useful for support, not a secret — kept')
  assert.ok(out.includes('"attempt":2'), 'non-secret context preserved')
})

// ── mailto ──
t('builds a mailto url with encoded subject and body', () => {
  const url = buildMailtoUrl({ to: 'support@capgo.app', subject: 'A & B', body: 'line1\nline2' })
  assert.ok(url.startsWith('mailto:support@capgo.app?'))
  assert.ok(url.includes('subject=A%20%26%20B'))
  assert.ok(url.includes('body=line1%0Aline2'))
})

t('caps the body length and appends a truncation marker', () => {
  const long = 'x'.repeat(MAILTO_BODY_MAX + 500)
  const url = buildMailtoUrl({ to: 'support@capgo.app', subject: 's', body: long })
  const body = decodeURIComponent(url.split('body=')[1])
  assert.ok(body.length <= MAILTO_BODY_MAX)
  assert.ok(body.endsWith('…(truncated)'))
})

// ── help-menu ──
t('support is always first', () => {
  const opts = buildHelpMenuOptions({ hasBuildLog: false })
  assert.equal(opts[0].value, 'support')
})

t('AI only offered when a build log exists', () => {
  assert.ok(!buildHelpMenuOptions({ hasBuildLog: false }).some(o => o.value === 'ai'))
  assert.ok(buildHelpMenuOptions({ hasBuildLog: true }).some(o => o.value === 'ai'))
})

t('always includes retry and exit', () => {
  const values = buildHelpMenuOptions({ hasBuildLog: true }).map(o => o.value)
  assert.ok(values.includes('retry'))
  assert.ok(values.includes('exit'))
})

// ── bundle-files ──
t('writes both .log and .log.gz with identical decoded content', () => {
  const dir = join(tmpdir(), `capgo-bundle-${Date.now()}`)
  const res = writeSupportBundleFiles({ kind: 'build-init', appId: 'com.example.app', error: 'boom', logs: ['l1', 'l2'] }, dir)
  assert.ok(res)
  assert.ok(res.logPath.endsWith('.log'))
  assert.ok(res.gzPath.endsWith('.log.gz'))
  const plain = readFileSync(res.logPath, 'utf8')
  const fromGz = gunzipSync(readFileSync(res.gzPath)).toString('utf8')
  assert.equal(plain, fromGz)
  assert.ok(plain.includes('boom'))
  rmSync(dir, { recursive: true, force: true })
})

t('renderBundleWithinGzCap trims the oldest build-output lines to fit, keeping the failure tail', () => {
  const buildLines = []
  for (let i = 0; i < 5000; i++)
    buildLines.push(`build line ${i} ${'x'.repeat(48)}`)
  buildLines.push('FATAL: the real failure is right here at the very end')
  const input = {
    kind: 'build-init',
    appId: 'com.example.app',
    error: 'boom',
    sections: [
      { title: 'Build output (full)', lines: buildLines },
      { title: 'AI analysis', lines: ['keep this small section intact'] },
    ],
    logs: ['recent activity line'],
  }
  const cap = 6000 // tiny cap to force trimming without generating 10 MB of entropy
  const { rendered, gz } = renderBundleWithinGzCap(input, cap)
  assert.ok(gz.length <= cap, `gz ${gz.length} must be at or under cap ${cap} (marker included)`)
  assert.equal(rendered, gunzipSync(gz).toString('utf8')) // .log and .log.gz stay in sync
  assert.ok(rendered.includes('FATAL: the real failure is right here at the very end'), 'failure tail kept')
  assert.ok(/omitted to fit the .* MB support upload limit/.test(rendered), 'truncation marker present')
  assert.ok(rendered.includes('boom'), 'error line preserved')
  assert.ok(rendered.includes('keep this small section intact'), 'small sections preserved')
  assert.ok(!rendered.includes('build line 0 '), 'oldest build line dropped')
})

t('renderBundleWithinGzCap fits via binary search — few gzip passes, not linear', () => {
  const buildLines = []
  for (let i = 0; i < 20000; i++)
    buildLines.push(`build line ${i} step=${i * 7} ${'x'.repeat(20)}`)
  buildLines.push('FATAL tail line')
  let passes = 0
  const { gz, rendered } = renderBundleWithinGzCap({
    kind: 'build-init', appId: 'a', error: 'boom',
    sections: [{ title: 'Build output (full)', lines: buildLines }],
  }, 6000, () => { passes++ })
  assert.ok(gz.length <= 6000, `gz ${gz.length} within cap (marker included)`)
  assert.ok(rendered.includes('FATAL tail line'), 'failure tail kept')
  // Binary search ≈ log2(n) probes; a linear 100-or-500-per-pass walk would be
  // hundreds-to-thousands. Pin that we stay tiny.
  assert.ok(passes <= 60, `expected few gzip passes, got ${passes}`)
})

t('renderBundleWithinGzCap leaves a normal bundle untouched (no marker)', () => {
  const { rendered } = renderBundleWithinGzCap({
    kind: 'build-init', appId: 'com.example.app', error: 'boom',
    sections: [{ title: 'Build output (full)', lines: ['line a', 'line b', 'line c'] }],
  })
  assert.ok(rendered.includes('line a') && rendered.includes('line c'))
  assert.ok(!/omitted to fit/.test(rendered), 'no marker when under cap')
})

t('renderBundleWithinGzCap terminates + degrades when non-trimmable content alone exceeds the cap', () => {
  // A giant AI-analysis section (never trimmed) bigger than a tiny cap: the trimmer
  // empties the build output, can't get under, and returns WITHOUT looping forever.
  const ai = Array.from({ length: 4000 }, (_, i) => `ai reasoning line ${i} step=${i * 13}`)
  let passes = 0
  const { gz } = renderBundleWithinGzCap({
    kind: 'build-init', appId: 'a', error: 'boom',
    sections: [
      { title: 'Build output (full)', lines: ['only', 'a', 'few', 'build', 'lines'] },
      { title: 'AI analysis', lines: ai },
    ],
  }, 1000, () => { passes++ }) // cap below the AI section's own size → unfittable
  // It returns (no hang); the result is simply still over cap → caller's upload
  // falls back to attach. Pin termination with a tiny, bounded pass count.
  assert.ok(gz.length > 1000, 'cannot fit when the untrimmable section alone exceeds the cap')
  assert.ok(passes <= 60, `must still terminate in few passes, got ${passes}`)
})

// ── contact ──
{
  function makeDeps(overrides = {}) {
    resetSupportUploadCacheForTests() // each test starts with a clean per-run upload cache
    const calls = { copied: [], opened: [], revealed: [], printed: [], confirmedWith: [] }
    const deps = {
      subject: 'Capgo Builder support',
      body: 'hello',
      confirm: async (_msg, logPath) => { calls.confirmedWith.push(logPath); return true },
      buildFiles: () => ({ logPath: '/x/b.log', gzPath: '/x/b.log.gz' }),
      copyPath: (p) => { calls.copied.push(p); return true },
      reveal: (p) => { calls.revealed.push(p) },
      openUrl: async (u) => { calls.opened.push(u) },
      print: (m) => { calls.printed.push(m) },
      ...overrides,
    }
    return { deps, calls }
  }

  await ta('cancels without writing/opening when confirm is false', async () => {
    const { deps, calls } = makeDeps({ confirm: async () => false })
    const result = await contactSupport(deps)
    assert.equal(result, 'cancelled')
    assert.equal(calls.opened.length, 0)
    assert.equal(calls.copied.length, 0)
  })

  await ta('copies the GZIPPED path (not the plain .log)', async () => {
    const { deps, calls } = makeDeps()
    await contactSupport(deps)
    assert.deepEqual(calls.copied, ['/x/b.log.gz'])
  })

  await ta('opens a mailto: to support@capgo.app and prints instructions', async () => {
    const { deps, calls } = makeDeps()
    const result = await contactSupport(deps)
    assert.equal(result, 'opened')
    assert.ok(calls.opened[0].startsWith('mailto:support@capgo.app?'))
    assert.ok(decodeURIComponent(calls.opened[0]).includes('/x/b.log.gz')) // path is in the email body
    assert.ok(calls.printed.some(m => m.includes('support@capgo.app')))
  })

  await ta('returns failed when files cannot be written', async () => {
    const { deps } = makeDeps({ buildFiles: () => null })
    assert.equal(await contactSupport(deps), 'failed')
  })

  await ta('builds the bundle BEFORE confirm and passes the .log path for inspection', async () => {
    const order = []
    const { deps, calls } = makeDeps({
      buildFiles: () => { order.push('build'); return { logPath: '/x/b.log', gzPath: '/x/b.log.gz' } },
      confirm: async (_m, logPath) => { order.push('confirm'); calls.confirmedWith.push(logPath); return true },
    })
    await contactSupport(deps)
    assert.deepEqual(order.slice(0, 2), ['build', 'confirm']) // bundle exists before we ask
    assert.deepEqual(calls.confirmedWith, ['/x/b.log']) // readable path handed to the confirm
  })

  await ta('upload success: link in email body, no clipboard/reveal/attach text', async () => {
    const uploads = []
    const { deps, calls } = makeDeps({
      upload: async (gzPath) => { uploads.push(gzPath); return { id: 'a'.repeat(64), url: 'https://api.capgo.app/builder_support_logs/' + 'a'.repeat(64) } },
    })
    const result = await contactSupport(deps)
    assert.equal(result, 'opened')
    assert.deepEqual(uploads, ['/x/b.log.gz']) // uploads the gzip
    const body = decodeURIComponent(calls.opened[0])
    assert.ok(body.includes('builder_support_logs/' + 'a'.repeat(64))) // download link in the email
    assert.ok(!body.includes('Please attach')) // send-ready, no attach instructions
    assert.equal(calls.copied.length, 0) // no clipboard needed
    assert.equal(calls.revealed.length, 0) // no Finder reveal needed
    assert.ok(calls.printed.some(m => m.includes('press Send')))
  })

  await ta('upload failure degrades to the manual attach flow', async () => {
    const { deps, calls } = makeDeps({ upload: async () => null })
    const result = await contactSupport(deps)
    assert.equal(result, 'opened')
    assert.deepEqual(calls.copied, ['/x/b.log.gz']) // clipboard fallback kicks in
    assert.ok(decodeURIComponent(calls.opened[0]).includes('Please attach')) // attach instructions back
  })

  await ta('logs link survives body truncation (long error text)', async () => {
    const url = 'https://api.capgo.app/builder_support_logs/' + 'b'.repeat(64)
    const { deps, calls } = makeDeps({
      body: 'Error: ' + 'x'.repeat(5000), // way past the mailto body cap
      upload: async () => ({ id: 'b'.repeat(64), url }),
    })
    await contactSupport(deps)
    const body = decodeURIComponent(calls.opened[0].split('body=')[1])
    assert.ok(body.endsWith(url)) // the link is NEVER truncated away
    assert.ok(body.includes('…(truncated)')) // the long prefix is what got cut
  })

  await ta('attach path survives body truncation in the fallback flow', async () => {
    const { deps, calls } = makeDeps({ body: 'Error: ' + 'y'.repeat(5000) })
    await contactSupport(deps)
    const body = decodeURIComponent(calls.opened[0].split('body=')[1])
    assert.ok(body.includes('/x/b.log.gz')) // attach path preserved despite truncation
  })

  await ta('upload failure is announced, not silent', async () => {
    const { deps, calls } = makeDeps({ upload: async () => null })
    await contactSupport(deps)
    assert.ok(calls.printed.some(m => m.includes('upload to Capgo failed')))
  })

  await ta('repeat Email support reuses the first upload — no second upload, no rate-limit hit', async () => {
    const url = 'https://api.capgo.app/builder_support_logs/' + 'c'.repeat(64)
    const uploads = []
    const { deps, calls } = makeDeps({ // makeDeps resets the cache once, at the start
      upload: async (gz) => { uploads.push(gz); return { id: 'c'.repeat(64), url } },
    })
    await contactSupport(deps) // first click → uploads
    await contactSupport(deps) // second click → must REUSE, not upload again
    assert.equal(uploads.length, 1) // uploaded exactly once for the whole run
    assert.equal(calls.opened.length, 2) // but a mail was opened both times
    assert.ok(decodeURIComponent(calls.opened[0]).includes('c'.repeat(64)))
    assert.ok(decodeURIComponent(calls.opened[1]).includes('c'.repeat(64))) // same link reused
    assert.ok(calls.printed.some(m => m.includes('reusing the logs you already uploaded')))
  })

  await ta('confirm copy discloses the upload + 30-day retention when uploading', async () => {
    let confirmMsg = ''
    const { deps } = makeDeps({
      confirm: async (msg) => { confirmMsg = msg; return false },
      upload: async () => null,
    })
    await contactSupport(deps)
    assert.ok(confirmMsg.includes('upload your logs to Capgo support'))
    assert.ok(confirmMsg.includes('kept 30 days'))
    assert.ok(!confirmMsg.includes('save your logs locally')) // no misleading "save locally" wording
  })
}

// ── upload-prompt ──
{
  // Covers the ADDITIVE "also upload logs to Capgo support?" gate that now runs
  // before AI analysis on a failed build (both the post-onboarding clack menu and
  // the onboarding Ink flow). The gate is upload-only: it never composes a mailto.

  const MOCK_UPLOAD_URL = `https://api.capgo.app/builder_support_logs/${'a'.repeat(64)}`

  function makeDeps(overrides = {}) {
    const calls = { confirmed: [], built: 0, uploaded: [], printed: [] }
    const deps = {
      confirm: async (msg) => { calls.confirmed.push(msg); return true },
      buildFiles: () => { calls.built++; return { gzPath: '/x/b.log.gz' } },
      upload: async (gzPath) => { calls.uploaded.push(gzPath); return { id: 'a'.repeat(64), url: MOCK_UPLOAD_URL } },
      print: (m) => { calls.printed.push(m) },
      ...overrides,
    }
    return { deps, calls }
  }

  await ta('declining the gate does NOT build or upload anything', async () => {
    const { deps, calls } = makeDeps({ confirm: async () => false })
    const outcome = await offerSupportUploadBeforeAi(deps)
    assert.equal(outcome, 'declined')
    assert.equal(calls.built, 0)
    assert.equal(calls.uploaded.length, 0)
    assert.equal(calls.printed.length, 0) // nothing printed when declined
  })

  await ta('the gate prompt offers the additive upload and mentions email follow-up', async () => {
    let asked = ''
    const { deps } = makeDeps({ confirm: async (msg) => { asked = msg; return false } })
    await offerSupportUploadBeforeAi(deps)
    assert.equal(asked, SUPPORT_UPLOAD_PROMPT)
    assert.ok(SUPPORT_UPLOAD_PROMPT.includes('Capgo support'))
    assert.ok(/email/i.test(SUPPORT_UPLOAD_PROMPT)) // tells the user support follows up by email
  })

  await ta('accepting builds the bundle then uploads the GZIP', async () => {
    const order = []
    const { deps, calls } = makeDeps({
      buildFiles: () => { order.push('build'); return { gzPath: '/x/b.log.gz' } },
      upload: async (gz) => { order.push('upload'); calls.uploaded.push(gz); return { id: 'a'.repeat(64), url: 'u' } },
    })
    const outcome = await offerSupportUploadBeforeAi(deps)
    assert.equal(outcome, 'uploaded')
    assert.deepEqual(order, ['build', 'upload']) // bundle is written before the network upload
    assert.deepEqual(calls.uploaded, ['/x/b.log.gz'])
  })

  await ta('on upload success it prints the "support will be in touch by email" line — and no mailto', async () => {
    const { deps, calls } = makeDeps()
    await offerSupportUploadBeforeAi(deps)
    // The success line now appends a `Reference: <url>` line, so assert the
    // printed confirmation matches the helper output for the uploaded URL.
    assert.ok(calls.printed.some(m => m === supportUploadConfirmation(MOCK_UPLOAD_URL)))
    const printed = calls.printed.join('\n')
    assert.ok(/in touch by email/i.test(printed))
    assert.ok(!printed.includes('mailto:')) // upload-only — never composes mail
    assert.ok(!/press Send/i.test(printed)) // not the email flow
  })

  await ta('bundle write failure is reported and does not throw', async () => {
    const { deps, calls } = makeDeps({ buildFiles: () => null })
    const outcome = await offerSupportUploadBeforeAi(deps)
    assert.equal(outcome, 'failed')
    assert.equal(calls.uploaded.length, 0)
    assert.ok(calls.printed.length >= 1) // user is told it couldn't be sent
  })

  await ta('upload returning null degrades to "unavailable" and is announced, not silent', async () => {
    const { deps, calls } = makeDeps({ upload: async () => null })
    const outcome = await offerSupportUploadBeforeAi(deps)
    assert.equal(outcome, 'unavailable')
    assert.ok(calls.printed.some(m => /unavailable|couldn'?t|could not/i.test(m)))
  })

  await ta('an upload that throws is swallowed (best-effort) and never breaks the AI flow', async () => {
    const { deps } = makeDeps({ upload: async () => { throw new Error('network down') } })
    const outcome = await offerSupportUploadBeforeAi(deps)
    assert.equal(outcome, 'unavailable') // treated like an unavailable upload, not a crash
  })

  await ta('a confirm that throws is swallowed and treated as declined', async () => {
    const { deps, calls } = makeDeps({ confirm: async () => { throw new Error('tty gone') } })
    const outcome = await offerSupportUploadBeforeAi(deps)
    assert.equal(outcome, 'declined')
    assert.equal(calls.built, 0)
  })
}
