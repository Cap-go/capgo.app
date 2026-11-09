import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { ChangelogSource } from './changelog.ts'
import { z } from 'zod'
import { NPM_PACKAGE_PATTERN } from './changelog.ts'
import { cachedChangelog } from './changelog_cache.ts'
import { quickError, simpleError } from './hono.ts'

const metadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  repository: z.union([z.string(), z.object({ url: z.string(), directory: z.string().optional() })]).optional(),
})

export interface ChangelogDependency {
  name: string
  version: string
  description: string
  source: ChangelogSource | null
}

/** Only public GitHub repository coordinates from npm, with no credentials or arbitrary fetch hosts. */
export function dependencySource(metadata: z.infer<typeof metadataSchema>): ChangelogSource | null {
  const repository = metadata.repository
  const url = typeof repository === 'string' ? repository : repository?.url ?? ''
  const match = /^(?:git\+https?:\/\/github\.com\/|https?:\/\/github\.com\/|git:\/\/github\.com\/|git\+ssh:\/\/git@github\.com\/|git@github\.com:)([\w-]+)\/([\w.-]+?)(?:\.git)?\/?(?:#.*)?$/i.exec(url)
  if (!match || match[2].startsWith('.'))
    return null
  const directory = typeof repository === 'object' ? repository.directory : undefined
  const safeDirectory = directory && directory.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..') ? directory : undefined
  return {
    owner: match[1],
    repo: match[2],
    tagPrefix: '',
    packageName: metadata.name,
    monorepo: !!safeDirectory,
    directory: safeDirectory,
  }
}

export function getDependency(c: Context<MiddlewareKeyVariables>, name: unknown): Promise<ChangelogDependency> {
  if (typeof name !== 'string' || name.length > 214 || !NPM_PACKAGE_PATTERN.test(name))
    throw simpleError('invalid_changelog_package', 'A valid npm package name is required')
  return cachedChangelog(c, {
    path: '/private/changelog/dependency',
    params: { name, v: '1' },
    ttl: 60 * 60,
    load: async () => {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok)
        throw quickError(response.status === 404 ? 404 : 502, 'changelog_package_unavailable', 'Could not load this public npm package')
      const parsed = metadataSchema.safeParse(await response.json())
      if (!parsed.success || parsed.data.name !== name)
        throw quickError(502, 'changelog_package_invalid', 'Could not read npm package metadata')
      return { name, version: parsed.data.version, description: parsed.data.description ?? '', source: dependencySource(parsed.data) }
    },
  })
}
