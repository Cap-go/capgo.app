#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'
import { z } from 'zod'
import { parseJsonc } from './generate-plugin-route-hosts.ts'
import { LOCAL_URL_HEADER, LOCAL_WORKER_HEADER } from './local-cloudflare-proxy-headers.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Bun-only APIs, typed here: the unit test compiles this file with the
// Workers types of the backend project, which have no Bun declarations.
interface LoopbackServer { stop: (closeActiveConnections?: boolean) => unknown }
interface BunServeApi {
  serve: (options: { hostname: string, port: number, idleTimeout: number, fetch: (request: Request) => Response | Promise<Response> }) => LoopbackServer
}
const localConfigSchema = z.looseObject({
  main: z.string().min(1),
  env: z.looseObject({
    local: z.looseObject({ name: z.string().min(1) }),
  }),
})
const portSchema = z.coerce.number().int().min(1).max(65535)
const optionsSchema = z.object({
  root: z.string(),
  runtimeEnvFile: z.string(),
  persistDir: z.string(),
  apiPort: portSchema,
  pluginPort: portSchema,
  filesPort: portSchema,
  inspectorPort: portSchema,
})
export type LocalWorkerOptions = z.infer<typeof optionsSchema>

export function prepareLocalWorkerConfig(configPath: string, compatibilityDate: string) {
  const config = localConfigSchema.parse(parseJsonc(readFileSync(configPath, 'utf8')))
  // These paths would otherwise become relative to the temporary config folder.
  for (const key of ['assets', 'site', 'build', 'base_dir', 'wasm_modules', 'text_blobs', 'data_blobs']) {
    if (key in config)
      throw new Error(`Local Workers launcher needs path handling for ${key}`)
  }
  // Workers AI has no local simulator. A single `wrangler dev --local` leaves
  // it out ("not supported"); a multi-config runtime would instead open a
  // remote proxy session, which needs Cloudflare credentials CI does not have.
  const { ai: _ai, ...topLevel } = config
  const { ai: _localAi, ...local } = config.env.local
  return {
    ...topLevel,
    env: { ...config.env, local },
    main: resolve(dirname(configPath), config.main),
    compatibility_date: compatibilityDate,
  }
}

export function localCompatibilityDate(env = process.env) {
  const today = new Date().toISOString().slice(0, 10)
  const maximum = env.WRANGLER_DEV_MAX_COMPATIBILITY_DATE ?? '2026-11-11'
  return env.WRANGLER_DEV_COMPATIBILITY_DATE ?? [today, maximum].sort()[0]
}

export function forwardLocalWorkerRequest(request: Request, target: 'plugin' | 'files', apiPort: number) {
  const original = new URL(request.url)
  const upstream = new URL(request.url)
  upstream.hostname = '127.0.0.1'
  upstream.port = String(apiPort)
  const forwarded = new Request(upstream, request)
  forwarded.headers.set(LOCAL_WORKER_HEADER, target)
  forwarded.headers.set(LOCAL_URL_HEADER, original.href)
  // Bun's fetch option: keep compressed bytes and their headers as sent.
  const init: RequestInit & { decompress: boolean } = { redirect: 'manual', decompress: false }
  return fetch(forwarded, init)
}

export async function runLocalCloudflareWorkers(options: LocalWorkerOptions) {
  const runtimeEnv = readFileSync(options.runtimeEnvFile, 'utf8')
  if ('UPDATES_CACHE_LOCAL_PURGE_URL' in parse(runtimeEnv))
    throw new Error('Keep the API-only purge URL out of the shared Cloudflare env file')
  if (new Set([options.apiPort, options.pluginPort, options.filesPort]).size !== 3)
    throw new Error('Local Workers require three distinct public ports')

  const temporary = mkdtempSync(join(options.persistDir, 'launcher-'))
  const configPaths: string[] = []
  const names: string[] = []
  const compatibilityDate = localCompatibilityDate()
  const writePrivate = (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 })
  let child: ReturnType<typeof spawn> | undefined
  const proxies: LoopbackServer[] = []
  const bun = (globalThis as unknown as { Bun: BunServeApi }).Bun
  let stopping = false
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid)
      return
    try {
      process.kill(-child.pid, signal)
    }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        throw error
    }
  }
  const groupExists = () => {
    if (!child?.pid)
      return false
    try {
      process.kill(-child.pid, 0)
      return true
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        return false
      throw error
    }
  }
  const stop = () => {
    if (!stopping) {
      stopping = true
      signalGroup('SIGTERM')
    }
  }
  const removeTemporary = () => {
    for (const proxy of proxies)
      proxy.stop(true)
    rmSync(temporary, { recursive: true, force: true })
  }
  const emergencyExit = () => {
    signalGroup('SIGTERM')
    removeTemporary()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  process.once('exit', emergencyExit)
  try {
    for (const kind of ['api', 'plugin', 'files']) {
      const config = prepareLocalWorkerConfig(join(options.root, 'cloudflare_workers', kind, 'wrangler.jsonc'), compatibilityDate)
      const folder = join(temporary, kind)
      mkdirSync(folder, { mode: 0o700 })
      const configPath = join(folder, 'wrangler.jsonc')
      writePrivate(configPath, JSON.stringify(config))
      const apiOnly = kind === 'api' ? `\nUPDATES_CACHE_LOCAL_PURGE_URL=http://127.0.0.1:${options.pluginPort}/cache_purge_local\n` : ''
      writePrivate(join(folder, '.dev.vars.local'), runtimeEnv + apiOnly)
      configPaths.push(configPath)
      names.push(config.env.local.name)
    }
    const [api, plugin, files] = z.tuple([z.string(), z.string(), z.string()]).parse(names)
    const routerConfig = join(temporary, 'router.jsonc')
    writePrivate(routerConfig, JSON.stringify({
      main: join(ROOT, 'scripts/local-cloudflare-router.ts'),
      compatibility_date: compatibilityDate,
      env: { local: {
        name: 'capgo-test-router',
        services: [{ binding: 'API', service: api }, { binding: 'PLUGIN', service: plugin }, { binding: 'FILES', service: files }],
      } },
    }))
    const command = [join(ROOT, 'scripts/wrangler-dev-compat.sh'), '--local', '--env=local',
      '--port', String(options.apiPort), '--inspector-port', String(options.inspectorPort),
      '--persist-to', options.persistDir, '-c', routerConfig,
      ...configPaths.flatMap(path => ['-c', path])]
    child = spawn('bash', command, { cwd: ROOT, detached: true, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
    proxies.push(bun.serve({ hostname: '127.0.0.1', port: options.pluginPort, idleTimeout: 0,
      fetch: request => forwardLocalWorkerRequest(request, 'plugin', options.apiPort) }))
    proxies.push(bun.serve({ hostname: '127.0.0.1', port: options.filesPort, idleTimeout: 0,
      fetch: request => forwardLocalWorkerRequest(request, 'files', options.apiPort) }))
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child?.once('error', reject)
      child?.once('exit', resolveExit)
    })
    if (!stopping && code !== 0)
      throw new Error(`Local Workers runtime exited with code ${code}`)
  }
  finally {
    stop()
    // The wrapper may exit before its workerd descendant. Wait for the entire
    // owned process group before removing watched configs and private vars.
    const deadline = Date.now() + 3000
    while (groupExists() && Date.now() < deadline)
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    if (groupExists())
      signalGroup('SIGKILL')
    removeTemporary()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    process.removeListener('exit', emergencyExit)
  }
}

if (import.meta.main) {
  const [root, runtimeEnvFile, persistDir, apiPort, pluginPort, filesPort, inspectorPort] = process.argv.slice(2)
  await runLocalCloudflareWorkers(optionsSchema.parse({ root, runtimeEnvFile, persistDir, apiPort, pluginPort, filesPort, inspectorPort }))
}
