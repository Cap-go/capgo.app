import type { BuiltSnippet } from './catalog.ts'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SNIPPETS, validateSnippets } from './catalog.ts'

export async function buildSnippets(): Promise<BuiltSnippet[]> {
  const root = resolve(import.meta.dir, '../..')
  const snippets = await Promise.all(SNIPPETS.map(async ({ name, source, rule }) => {
    const sourcePath = resolve(root, source)
    const hash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
    const result = await Bun.build({ entrypoints: [sourcePath], minify: true, target: 'browser', format: 'esm' })
    if (!result.success || result.outputs.length !== 1)
      throw new Error(`Failed to build ${name}: ${result.logs.join('\n')}`)
    return { name, code: `// ${name} source:${hash}\n${await result.outputs[0].text()}`, ...(rule ? { rule } : {}) }
  }))
  validateSnippets(snippets)
  return snippets
}

if (import.meta.main) {
  for (const snippet of await buildSnippets())
    console.log(`${snippet.name}: ${new TextEncoder().encode(snippet.code).length} bytes`)
}
