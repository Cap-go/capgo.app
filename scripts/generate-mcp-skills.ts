import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// Only these public, reviewed directories are published. Never scan a user's installed skills.
export const MCP_SKILL_SOURCES = [
  'skills/check-update-health',
  'skills/ship-live-update',
  'cli/skills/native-builds',
  'cli/skills/observe',
  'cli/skills/organization-management',
  'cli/skills/release-management',
  'cli/skills/usage',
] as const

const output = 'cli/src/mcp/skills.generated.json'
const mimeTypes: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.ts': 'text/plain',
  '.js': 'text/javascript', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
}

export async function buildMcpSkillCatalog(root: string) {
  const skills = []
  const contents: Array<{ uri: string, mimeType: string, text?: string, blob?: string }> = []
  const names = new Set<string>()
  for (const source of MCP_SKILL_SOURCES) {
    const directory = join(root, source)
    let ancestor = root
    for (const segment of source.split('/')) {
      ancestor = join(ancestor, segment)
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error(`Skill symlinks are not published: ${ancestor}`)
    }
    const files: string[] = []
    async function collect(path: string) {
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw new Error(`Skill symlinks are not published: ${path}`)
      if (info.isDirectory()) {
        for (const child of (await readdir(path)).sort())
          await collect(join(path, child))
      }
      else if (info.isFile()) {
        files.push(path)
        if (files.length > 512)
          throw new Error(`Too many files in skill: ${source}`)
      }
      else {
        throw new Error(`Unsupported skill file: ${path}`)
      }
    }
    await collect(directory)
    const markdown = await readFile(join(directory, 'SKILL.md'), 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
    const frontmatter = match ? parse(match[1]) : null
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)
      || typeof frontmatter.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name)
      || frontmatter.name !== basename(directory) || typeof frontmatter.description !== 'string' || !frontmatter.description.trim())
      throw new Error(`Invalid skill frontmatter: ${source}`)
    if (names.has(frontmatter.name))
      throw new Error(`Duplicate skill name: ${frontmatter.name}`)
    names.add(frontmatter.name)
    const uri = `skill://capgo/${frontmatter.name}/SKILL.md`
    const resources = []
    let size = 0
    for (const path of files) {
      const bytes = await readFile(path)
      size += bytes.length
      if (size > 16 * 1024 * 1024)
        throw new Error(`Skill exceeds 16 MiB: ${source}`)
      const fileUri = `skill://capgo/${frontmatter.name}/${relative(directory, path).split(/[\\/]/).map(encodeURIComponent).join('/')}`
      const mimeType = mimeTypes[extname(path)] ?? 'application/octet-stream'
      resources.push({ uri: fileUri, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length })
      contents.push({
        uri: fileUri,
        mimeType,
        ...(mimeType === 'application/octet-stream' ? { blob: Buffer.from(bytes).toString('base64') } : { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }),
      })
    }
    skills.push({ uri, frontmatter: frontmatter as { name: string, description: string, [key: string]: unknown }, resources })
  }
  skills.sort((a, b) => a.uri.localeCompare(b.uri, 'en'))
  contents.sort((a, b) => a.uri.localeCompare(b.uri, 'en'))
  return { skills, contents }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const generated = `${JSON.stringify(await buildMcpSkillCatalog(root), null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (await readFile(join(root, output), 'utf8') !== generated)
      throw new Error('MCP skill catalog is stale. Run bun run generate:mcp-skills.')
  }
  else {
    await writeFile(join(root, output), generated)
  }
}
