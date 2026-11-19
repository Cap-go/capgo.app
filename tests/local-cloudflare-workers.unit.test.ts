import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localCompatibilityDate, prepareLocalWorkerConfig } from '../scripts/local-cloudflare-workers.ts'
import router from '../scripts/local-cloudflare-router.ts'
import { LOCAL_URL_HEADER, LOCAL_WORKER_HEADER } from '../scripts/local-cloudflare-proxy-headers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'capgo-single-worker-test-'))
  for (const kind of ['api', 'plugin', 'files']) {
    const worker = join(folder, 'cloudflare_workers', kind)
    mkdirSync(worker, { recursive: true })
    writeFileSync(join(worker, 'index.ts'), 'export default {}')
    writeFileSync(join(worker, 'wrangler.jsonc'), JSON.stringify({
      name: `synthetic-${kind}`, main: './index.ts', compatibility_flags: ['nodejs_compat'],
      env: { local: { name: `synthetic-${kind}-local`, vars: { EXISTING: 'kept' },
        kv_namespaces: [{ binding: 'STATE', id: 'synthetic-state' }],
        r2_buckets: [{ binding: 'POINTERS', bucket_name: 'synthetic-pointers' }] } },
    }))
  }
  return folder
}

describe('single-owner local Workers launcher', () => {
  it('leaves the remote-only AI binding out, as a single --local wrangler dev does', () => {
    const folder = fixture()
    try {
      const path = join(folder, 'cloudflare_workers/api/wrangler.jsonc')
      const original = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...original, ai: { binding: 'AI' }, env: { local: { ...original.env.local, ai: { binding: 'AI' } } } }))
      const config = prepareLocalWorkerConfig(path, '2026-09-30') as Record<string, unknown> & { env: { local: Record<string, unknown> } }
      expect(config).not.toHaveProperty('ai')
      expect(config.env.local).not.toHaveProperty('ai')
      expect(config.env.local.kv_namespaces).toEqual([{ binding: 'STATE', id: 'synthetic-state' }])
    }
    finally { rmSync(folder, { recursive: true, force: true }) }
  })

  it('keeps bindings and flags while resolving each original entrypoint', () => {
    const folder = fixture()
    try {
      const path = join(folder, 'cloudflare_workers/api/wrangler.jsonc')
      const original = readFileSync(path, 'utf8')
      const config = prepareLocalWorkerConfig(path, '2026-09-30')
      expect(config.main).toBe(join(dirname(path), 'index.ts'))
      expect(config.compatibility_date).toBe('2026-09-30')
      expect((config as Record<string, unknown>).compatibility_flags).toEqual(['nodejs_compat'])
      expect(config.env.local).toEqual({ name: 'synthetic-api-local', vars: { EXISTING: 'kept' },
        kv_namespaces: [{ binding: 'STATE', id: 'synthetic-state' }],
        r2_buckets: [{ binding: 'POINTERS', bucket_name: 'synthetic-pointers' }] })
      expect(readFileSync(path, 'utf8')).toBe(original)
    }
    finally { rmSync(folder, { recursive: true, force: true }) }
  })

  it('clamps every copied worker to the same local compatibility date', () => {
    expect(localCompatibilityDate({ WRANGLER_DEV_MAX_COMPATIBILITY_DATE: '2026-09-30' })).toBe('2026-09-30')
    expect(localCompatibilityDate({ WRANGLER_DEV_COMPATIBILITY_DATE: '2026-08-01' })).toBe('2026-08-01')
  })

  it.each(['api', 'plugin', 'files'])('preserves %s requests and removes private proxy headers', async (kind) => {
    const received: Request[] = []
    const handler = { fetch: async (request: Request) => {
      received.push(request)
      return new Response(await request.text(), { status: 202, headers: { 'x-synthetic-worker': kind } })
    } }
    const incoming = new Request('http://127.0.0.1:12345/body?value=one', { method: 'PATCH', body: 'synthetic-body',
      headers: { [LOCAL_WORKER_HEADER]: kind, [LOCAL_URL_HEADER]: 'http://127.0.0.1:23456/body?value=one', 'x-request': 'kept' } })
    const response = await router.fetch(incoming, { API: handler, PLUGIN: handler, FILES: handler })
    expect(response.status).toBe(202)
    expect(response.headers.get('x-synthetic-worker')).toBe(kind)
    expect(await response.text()).toBe('synthetic-body')
    expect(received[0]?.url).toBe('http://127.0.0.1:23456/body?value=one')
    expect(received[0]?.method).toBe('PATCH')
    expect(received[0]?.headers.get('x-request')).toBe('kept')
    expect(received[0]?.headers.has(LOCAL_WORKER_HEADER)).toBe(false)
    expect(received[0]?.headers.has(LOCAL_URL_HEADER)).toBe(false)
  })

  it('uses the API binding for unwrapped requests', async () => {
    const called: string[] = []
    const binding = (kind: string) => ({ fetch: async () => { called.push(kind); return new Response(kind) } })
    const response = await router.fetch(new Request('http://127.0.0.1:12345/ok'), { API: binding('api'), PLUGIN: binding('plugin'), FILES: binding('files') })
    expect(await response.text()).toBe('api')
    expect(called).toEqual(['api'])
  })

  it('does not dispatch an unknown target', async () => {
    const handler = { fetch: async () => { throw new Error('must not dispatch') } }
    const response = await router.fetch(new Request('http://127.0.0.1/ok', { headers: { [LOCAL_WORKER_HEADER]: 'unknown' } }), { API: handler, PLUGIN: handler, FILES: handler })
    expect(response.status).toBe(400)
  })

  it('keeps per-worker secrets private and removes proxies/configs after child failure', () => {
    const folder = fixture()
    try {
      const persist = join(folder, 'persist')
      const bin = join(folder, 'bin')
      mkdirSync(persist)
      mkdirSync(bin)
      const runtimeEnv = join(folder, 'runtime.env')
      writeFileSync(runtimeEnv, 'SUPABASE_DB_URL=postgres://synthetic.invalid/test\nLOCAL_READ_REPLICA_SUPABASE_DB_URL=postgres://replica.invalid/test\nSYNTHETIC_SECRET=never-print-this\nPLUGIN_STATE_KV=on\n', { mode: 0o600 })
      const stub = join(folder, 'inspect.ts')
      writeFileSync(stub, `
        import {readFileSync,statSync} from 'node:fs'
        import {dirname,join} from 'node:path'
        import {parse} from ${JSON.stringify(join(ROOT, 'node_modules/dotenv/lib/main.js'))}
        const configs=[]
        for(let i=2;i<process.argv.length;i++)if(process.argv[i]==='-c')configs.push(process.argv[++i])
        const workers=configs.slice(1).map(path=>{
          const config=JSON.parse(readFileSync(path,'utf8'))
          const secretPath=join(dirname(path),'.dev.vars.local')
          const secrets=parse(readFileSync(secretPath,'utf8'))
          return {name:config.env.local.name,primary:secrets.SUPABASE_DB_URL==='postgres://synthetic.invalid/test',replica:secrets.LOCAL_READ_REPLICA_SUPABASE_DB_URL==='postgres://replica.invalid/test',kv:secrets.PLUGIN_STATE_KV,apiOnly:secrets.UPDATES_CACHE_LOCAL_PURGE_URL!==undefined,mode:statSync(secretPath).mode&0o777,secretInVars:JSON.stringify(config).includes('never-print-this')}
        })
        console.log(JSON.stringify({configCount:configs.length,workers}))
        process.exit(42)
      `)
      const bunx = join(bin, 'bunx')
      writeFileSync(bunx, '#!/usr/bin/env bash\nexec bun "$SYNTHETIC_INSPECT_SCRIPT" "$@"\n')
      chmodSync(bunx, 0o755)
      const result = spawnSync('bun', [join(ROOT, 'scripts/local-cloudflare-workers.ts'), folder, runtimeEnv, persist, '18731', '18732', '18733', '18734'], {
        cwd: ROOT, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SYNTHETIC_INSPECT_SCRIPT: stub },
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Local Workers runtime exited with code 42')
      const output = JSON.parse(result.stdout.trim())
      expect(output.configCount).toBe(4)
      expect(output.workers).toEqual(['api', 'plugin', 'files'].map(kind => ({ name: `synthetic-${kind}-local`, primary: true, replica: true, kv: 'on', apiOnly: kind === 'api', mode: 0o600, secretInVars: false })))
      expect(result.stdout + result.stderr).not.toContain('never-print-this')
      expect(readdirSync(persist)).toEqual([])
    }
    finally { rmSync(folder, { recursive: true, force: true }) }
  })
})
