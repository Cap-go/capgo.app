export interface GitHubProfile {
  id: number
  login: string
  name: string | null
  avatarUrl: string
}

export class GitHubProfileError extends Error {
  constructor(public readonly code: 'invalid_username' | 'not_found' | 'rate_limited' | 'request_failed') {
    super(code)
  }
}

export function normalizeGitHubUsername(username: string) {
  return username.trim()
}

export async function getGitHubProfile(username: string): Promise<GitHubProfile> {
  const normalizedUsername = normalizeGitHubUsername(username)
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(normalizedUsername))
    throw new GitHubProfileError('invalid_username')

  let response: Response
  try {
    response = await fetch(`https://api.github.com/users/${encodeURIComponent(normalizedUsername)}`, {
      headers: {
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10_000),
    })
  }
  catch {
    throw new GitHubProfileError('request_failed')
  }

  if (response.status === 404)
    throw new GitHubProfileError('not_found')
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))))
    throw new GitHubProfileError('rate_limited')
  if (!response.ok)
    throw new GitHubProfileError('request_failed')

  let profile: {
    id?: unknown
    login?: unknown
    name?: unknown
    avatar_url?: unknown
  }
  try {
    profile = await response.json()
  }
  catch {
    throw new GitHubProfileError('request_failed')
  }

  if (!profile || typeof profile !== 'object' || typeof profile.id !== 'number' || typeof profile.login !== 'string' || typeof profile.avatar_url !== 'string')
    throw new GitHubProfileError('request_failed')

  return {
    id: profile.id,
    login: profile.login,
    name: typeof profile.name === 'string' ? profile.name : null,
    avatarUrl: profile.avatar_url,
  }
}
