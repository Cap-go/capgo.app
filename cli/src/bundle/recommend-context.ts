import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify, stripVTControlCharacters } from 'node:util'

const exec = promisify(execFile)
export interface ReleaseContext {
  source: 'local' | 'github'
  commits: string
  changes: string
  tags: string
  truncated: boolean
}

// Only summaries and filenames are sent, never file contents or author identities.
export function boundContext(source: ReleaseContext['source'], commits: string, changes: string, tags: string, truncated = false): ReleaseContext {
  const clean = (value: string) => stripVTControlCharacters(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:gh[pousr]_\w+|github_pat_\w+|sk_(?:live|test)_[a-z0-9]+)\b/gi, '[secret]')
  return {
    source,
    commits: clean(commits).slice(0, 16000),
    changes: clean(changes).slice(0, 16000),
    tags: clean(tags).slice(0, 4000),
    truncated: truncated || commits.length > 16000 || changes.length > 16000 || tags.length > 4000,
  }
}

async function command(file: string, args: string[], cwd: string) {
  const { stdout } = await exec(file, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
  return stdout.trim()
}

export async function collectReleaseContext(options: { repo?: string, since?: string, ref?: string }, cwd = process.cwd()): Promise<ReleaseContext> {
  if (options.repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo) || !options.since || !options.ref)
      throw new Error('GitHub history requires --repo owner/repo, --since <ref>, and --ref <ref>')
    const route = `repos/${options.repo}/compare/${encodeURIComponent(options.since)}...${encodeURIComponent(options.ref)}`
    const compare = JSON.parse(await command('gh', ['api', route], cwd)) as {
      total_commits: number
      commits: { commit: { message: string } }[]
      files: { filename: string, status: string, additions: number, deletions: number }[]
    }
    if (!Array.isArray(compare.commits) || !Array.isArray(compare.files))
      throw new Error('GitHub returned incomplete comparison data')
    const tags = JSON.parse(await command('gh', ['api', `repos/${options.repo}/tags?per_page=50`], cwd)) as { name: string }[]
    return boundContext('github', compare.commits.slice(0, 100).map(c => c.commit.message.split('\n')[0]).join('\n'), compare.files.slice(0, 200).map(f => `${f.status} ${f.filename} +${f.additions} -${f.deletions}`).join('\n'), tags.map(t => t.name).join('\n'), compare.total_commits > 100 || compare.files.length >= 200 || tags.length >= 50)
  }

  // Resolve caller-controlled refs to object IDs before constructing ranges.
  const resolve = (ref: string) => command('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd)
  const head = await resolve(options.ref ?? 'HEAD')
  let since = options.since
  if (!since)
    since = await command('git', ['describe', '--tags', '--abbrev=0', head], cwd).catch(() => undefined)
  const base = since ? await resolve(since) : undefined
  const range = base ? `${base}..${head}` : head
  const commits = await command('git', ['log', '--format=%s', '-101', range, '--'], cwd)
  const changes = [
    base ? await command('git', ['diff', '--no-ext-diff', '--no-textconv', '--stat', base, head, '--'], cwd) : '',
    await command('git', ['diff', '--no-ext-diff', '--no-textconv', '--stat', head, '--'], cwd),
    await command('git', ['status', '--short', '--untracked-files=no'], cwd),
  ].filter(Boolean).join('\n')
  const tags = await command('git', ['for-each-ref', '--sort=-creatordate', '--count=50', '--format=%(refname:short)', 'refs/tags'], cwd)
  const lines = commits ? commits.split('\n') : []
  return boundContext('local', lines.slice(0, 100).join('\n'), changes, tags, !base || lines.length > 100 || tags.split('\n').length >= 50)
}
