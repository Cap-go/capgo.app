import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('parses R2 XML in the Worker browser build without DOM APIs and preserves copy/delete safety', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'r2-cleanup-worker-'))
  const wranglerRequire = createRequire(realpathSync(resolve('node_modules/wrangler/package.json')))
  const { build } = wranglerRequire('esbuild')
  const { parse } = wranglerRequire('jsonc-parser')
  // Workers lack DOMParser; exercise the deployed config's pure JavaScript parser alias.
  const config = parse(readFileSync(resolve('cloudflare_workers/r2_inventory/wrangler.jsonc'), 'utf8'))
  const outfile = join(directory, 'probe.cjs')
  const source = `
    import { createCleanupStorage } from ${JSON.stringify(resolve('cloudflare_workers/r2_inventory/cleanup_storage.ts'))}
    async function probe() {
    if (typeof DOMParser !== 'undefined') throw new Error('Probe must run without browser DOM APIs')
    const env = { S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'synthetic-access', S3_SECRET_ACCESS_KEY: 'synthetic-secret' }
    const copy = '<CopyObjectResult><ETag>"etag"</ETag><LastModified>2026-10-15T00:00:00Z</LastModified></CopyObjectResult>'
    const failure = code => '<Error><Code>' + code + '</Code><Message>Synthetic error</Message></Error>'
    const head = { status: 200, headers: { etag: '"etag"', 'content-length': '42' } }
    const cases = [
      ['success', [[copy, { status: 200 }], [null, { status: 204 }]]],
      ['embedded_error', [[failure('InternalError'), { status: 200 }]]],
      ['partial_copy', [['<CopyObjectResult><ETag>"etag"</ETag></CopyObjectResult>', { status: 200 }]]],
      ['existing_backup', [[failure('PreconditionFailed'), { status: 412 }], [null, head], [null, head], [null, { status: 204 }]]],
    ]
    const results = []
    for (const [name, responses] of cases) {
      const methods = []
      globalThis.fetch = async request => {
        methods.push(request.method)
        const response = responses.shift()
        if (!response) throw new Error('Unexpected synthetic request')
        return new Response(...response)
      }
      try {
        await createCleanupStorage(env).remove('capgo', 'orgs/synthetic/apps/com.test.cleanup/delta/file', 'etag', new AbortController().signal)
        results.push({ name, success: true, methods })
      } catch (error) {
        results.push({ name, success: false, errorType: error.name, methods })
      }
    }
    console.log(JSON.stringify(results))
    }
    probe().catch(error => { console.error(error); process.exitCode = 1 })
  `
  try {
    await build({
      stdin: { contents: source, loader: 'ts', resolveDir: process.cwd(), sourcefile: 'synthetic-cleanup-worker.ts' },
      bundle: true,
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      format: 'cjs',
      external: [...builtinModules, 'node:*', 'cloudflare:sockets'],
      target: 'es2022',
      alias: config.alias ?? {},
      outfile,
      logLevel: 'silent',
    })
    const results = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: 'utf8', timeout: 10000 }))
    expect(results).toEqual([
      { name: 'success', success: true, methods: ['PUT', 'DELETE'] },
      { name: 'embedded_error', success: false, errorType: 'InternalError', methods: ['PUT'] },
      { name: 'partial_copy', success: false, errorType: 'Error', methods: ['PUT'] },
      { name: 'existing_backup', success: true, methods: ['PUT', 'HEAD', 'HEAD', 'DELETE'] },
    ])
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
