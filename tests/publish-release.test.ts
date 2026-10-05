import { describe, expect, it } from 'vitest'
import { publishReleaseAtomically } from '../scripts/publish-release.ts'

const testedSha = '1111111111111111111111111111111111111111'
const releaseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const newerSha = '2222222222222222222222222222222222222222'

describe('atomic release publication', () => {
  it.concurrent('rejects remotes that start with a hyphen', () => {
    expect(() => publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: '--upload-pack=evil',
    })).toThrow('Release remote must be non-empty, contain no line breaks, and not start with "-"')
  })

  it.concurrent('treats a branch that moved before publication as safely superseded', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      if (args[0] === 'ls-remote')
        return `${newerSha}\trefs/heads/main`

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: ['capgo-12.0.0'],
      remote: 'origin',
    }, run)).toBe('superseded')
    expect(calls.some(args => args[0] === 'push')).toBe(false)
  })

  it.concurrent('publishes the release commit and only newly created tags atomically', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'ls-remote --heads origin refs/heads/main': `${testedSha}\trefs/heads/main`,
        'tag --list': 'capgo-12.0.0\ncapgo-12.0.1\ncli-8.50.2',
        'push --atomic origin HEAD:refs/heads/main refs/tags/capgo-12.0.1:refs/tags/capgo-12.0.1 refs/tags/cli-8.50.2:refs/tags/cli-8.50.2': '',
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: ['capgo-12.0.0'],
      remote: 'origin',
    }, run)).toBe('published')
    expect(calls).toContainEqual([
      'push',
      '--atomic',
      'origin',
      'HEAD:refs/heads/main',
      'refs/tags/capgo-12.0.1:refs/tags/capgo-12.0.1',
      'refs/tags/cli-8.50.2:refs/tags/cli-8.50.2',
    ])
  })

  it.concurrent('treats an atomic push race as safely superseded', () => {
    let remoteReads = 0
    const pushError = new Error('non-fast-forward')
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        remoteReads += 1
        const sha = remoteReads === 1 ? testedSha : newerSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'tag')
        return 'capgo-12.0.1'
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return releaseSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: 'origin',
    }, run)).toBe('superseded')
    expect(remoteReads).toBe(2)
  })

  it.concurrent('treats a lost push response as published when remote matches local HEAD and tags', () => {
    let remoteReads = 0
    const pushError = new Error('network timeout')
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        if (args.join(' ') === 'ls-remote --refs --tags origin refs/tags/capgo-12.0.1')
          return `${releaseSha}\trefs/tags/capgo-12.0.1`
        remoteReads += 1
        const sha = remoteReads === 1 ? testedSha : releaseSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'tag')
        return 'capgo-12.0.1'
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return releaseSha
      if (args[0] === 'rev-parse' && args[1] === 'refs/tags/capgo-12.0.1')
        return releaseSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: 'origin',
    }, run)).toBe('published')
    expect(remoteReads).toBe(2)
  })

  it.concurrent('preserves push failures when the branch matches but a tag is missing', () => {
    const pushError = new Error('network timeout')
    let remoteReads = 0
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        if (args.join(' ') === 'ls-remote --refs --tags origin refs/tags/capgo-12.0.1')
          return ''
        remoteReads += 1
        const sha = remoteReads === 1 ? testedSha : releaseSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'tag')
        return 'capgo-12.0.1'
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return releaseSha
      if (args[0] === 'rev-parse' && args[1] === 'refs/tags/capgo-12.0.1')
        return releaseSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: 'origin',
    }, run)).toThrow(pushError)
  })

  it.concurrent('preserves push failures when the branch matches but a tag differs', () => {
    const pushError = new Error('network timeout')
    let remoteReads = 0
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        if (args.join(' ') === 'ls-remote --refs --tags origin refs/tags/capgo-12.0.1')
          return `${newerSha}\trefs/tags/capgo-12.0.1`
        remoteReads += 1
        const sha = remoteReads === 1 ? testedSha : releaseSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'tag')
        return 'capgo-12.0.1'
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return releaseSha
      if (args[0] === 'rev-parse' && args[1] === 'refs/tags/capgo-12.0.1')
        return releaseSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: 'origin',
    }, run)).toThrow(pushError)
  })

  it.concurrent('preserves the original push failure when tag verification fails', () => {
    const pushError = new Error('network timeout')
    let remoteReads = 0
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote') {
        if (args.join(' ') === 'ls-remote --refs --tags origin refs/tags/capgo-12.0.1')
          throw new Error('tag lookup failed')
        remoteReads += 1
        const sha = remoteReads === 1 ? testedSha : releaseSha
        return `${sha}\trefs/heads/main`
      }
      if (args[0] === 'tag')
        return 'capgo-12.0.1'
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return releaseSha
      if (args[0] === 'rev-parse' && args[1] === 'refs/tags/capgo-12.0.1')
        return releaseSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: 'origin',
    }, run)).toThrow(pushError)
  })

  it.concurrent('preserves genuine push failures when the branch did not move', () => {
    const pushError = new Error('permission denied')
    const run = (args: string[]) => {
      if (args[0] === 'ls-remote')
        return `${testedSha}\trefs/heads/main`
      if (args[0] === 'tag')
        return 'capgo-12.0.1'
      if (args[0] === 'push')
        throw pushError
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return releaseSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => publishReleaseAtomically({
      branch: 'main',
      expectedBranchSha: testedSha,
      knownTags: [],
      remote: 'origin',
    }, run)).toThrow(pushError)
  })
})
