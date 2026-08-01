import type { GitHubProfileError } from '../src/services/githubProfile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGitHubProfile, normalizeGitHubUsername } from '../src/services/githubProfile'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('github profile lookup', () => {
  it('normalizes the entered username and requests the public GitHub API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 42,
      login: 'octocat',
      name: 'The Octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4',
    })))
    globalThis.fetch = fetchMock

    await expect(getGitHubProfile('  octocat  ')).resolves.toEqual({
      id: 42,
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
    })
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/users/octocat', expect.any(Object))
  })

  it('rejects invalid and unknown usernames with user-facing error codes', async () => {
    await expect(getGitHubProfile('invalid_username')).rejects.toMatchObject({ code: 'invalid_username' } satisfies Partial<GitHubProfileError>)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    await expect(getGitHubProfile('octocat')).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<GitHubProfileError>)
  })

  it('reports request failures from GitHub and malformed profile responses', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network unavailable'))
    await expect(getGitHubProfile('octocat')).rejects.toMatchObject({ code: 'request_failed' } satisfies Partial<GitHubProfileError>)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: 'Missing required fields' })))
    await expect(getGitHubProfile('octocat')).rejects.toMatchObject({ code: 'request_failed' } satisfies Partial<GitHubProfileError>)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not json'))
    await expect(getGitHubProfile('octocat')).rejects.toMatchObject({ code: 'request_failed' } satisfies Partial<GitHubProfileError>)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('null'))
    await expect(getGitHubProfile('octocat')).rejects.toMatchObject({ code: 'request_failed' } satisfies Partial<GitHubProfileError>)
  })

  it('trims usernames before validating them', () => {
    expect(normalizeGitHubUsername('  octocat  ')).toBe('octocat')
  })
})
