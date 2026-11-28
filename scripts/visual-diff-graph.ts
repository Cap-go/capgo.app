/**
 * Builds the console in the current directory and writes its module graph, so the visual diff
 * planner can tell which pages a change can reach. Run it with cwd set to the checkout to build
 * (the base revision is a separate worktree that may not have this script):
 *
 *   (cd <checkout> && bun <this repo>/scripts/visual-diff-graph.ts --out graph.json)
 *
 * The build uses that checkout's own vite and vite.config.mts; this file only adds a plugin.
 */
import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export interface GraphModule {
  /** sha256 of the transformed code, or of the file itself for stylesheets (see below). */
  hash: string
  imports: string[]
  dynamicImports: string[]
  /** Transformed code of first-party modules, used to find which pages use a message key. */
  code?: string
}

export interface ModuleGraph {
  root: string
  entries: string[]
  modules: Record<string, GraphModule>
}

function sha(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

export function graphPlugin(root: string, onGraph: (graph: ModuleGraph) => void): Plugin {
  const toKey = (id: string) => {
    const clean = id.split('?')[0]
    const keyed = clean.startsWith(root + sep) ? relative(root, clean).split(sep).join('/') : clean
    return id.includes('?') ? `${keyed}?${id.split('?').slice(1).join('?')}` : keyed
  }
  return {
    name: 'capgo-visual-diff-graph',
    apply: 'build',
    buildEnd() {
      const modules: ModuleGraph['modules'] = {}
      const entries: string[] = []
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id)
        if (!info)
          continue
        const key = toKey(id)
        if (info.isEntry)
          entries.push(key)
        const file = id.split('?')[0]
        // Tailwind generates a global stylesheet from the classes of every source file, so its
        // output changes whenever any page adds a class. A page that did not change still gets the
        // same rules, so hash the stylesheet source instead of the generated CSS.
        const plainStylesheet = !id.includes('?') && file.endsWith('.css') && existsSync(file)
        // Vue modules import their blocks by absolute path, which differs between two checkouts.
        const code = (plainStylesheet ? readFileSync(file, 'utf8') : (info.code ?? '')).split(root).join('<root>')
        const firstParty = !key.startsWith('/') && !key.startsWith('\0') && !key.includes('node_modules/')
        modules[key] = {
          hash: sha(code),
          imports: info.importedIds.map(toKey),
          dynamicImports: info.dynamicallyImportedIds.map(toKey),
          ...(firstParty && /\.(?:vue|[cm]?[jt]sx?)$/.test(key.split('?')[0]) ? { code } : {}),
        }
      }
      onGraph({ root, entries, modules })
    },
  }
}

function packageVersion(root: string, name: string) {
  try {
    const require = createRequire(resolve(root, 'package.json'))
    return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version as string
  }
  catch {
    return 'missing'
  }
}

async function main() {
  const outIndex = process.argv.indexOf('--out')
  const out = outIndex === -1 ? undefined : process.argv[outIndex + 1]
  if (!out)
    throw new Error('Usage: visual-diff-graph.ts --out <graph.json>')
  const root = process.cwd()
  const require = createRequire(resolve(root, 'package.json'))
  const vite = await import(pathToFileURL(require.resolve('vite')).href) as typeof import('vite')
  let graph: ModuleGraph | undefined
  await vite.build({
    root,
    configFile: resolve(root, 'vite.config.mts'),
    logLevel: 'warn',
    plugins: [graphPlugin(root, (value) => { graph = value })],
    build: { write: false, minify: false, sourcemap: false, reportCompressedSize: false },
  })
  if (!graph)
    throw new Error('The build finished without reporting its module graph')
  // The generated stylesheet also depends on the Tailwind release.
  graph.modules['\0tailwindcss-version'] = { hash: sha(packageVersion(root, 'tailwindcss')), imports: [], dynamicImports: [] }
  graph.entries.push('\0tailwindcss-version')
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(resolve(out), JSON.stringify(graph))
  console.log(`[visual-diff] wrote ${Object.keys(graph.modules).length} modules to ${out}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  })
}
