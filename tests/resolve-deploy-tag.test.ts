import { describe, expect, it } from 'vitest'
import {
  assertCurrentDeployTag,
  resolveDeployTag,
  resolveLatestDeployTag,
} from '../scripts/resolve-deploy-tag.ts'

const stableSha = '1111111111111111111111111111111111111111'
const alphaSha = '2222222222222222222222222222222222222222'

describe('latest deployment tag resolution', () => {
  it.concurrent('resolves the requested event tag without selecting a newer tag', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      if (args.join(' ') === 'rev-list -n 1 capgo-12.9.0')
        return stableSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(resolveDeployTag('capgo-12.9.0', run)).toEqual({
      isAlpha: false,
      sha: stableSha,
      tag: 'capgo-12.9.0',
    })
    expect(calls).toEqual([['rev-list', '-n', '1', 'capgo-12.9.0']])
  })

  it.concurrent('resolves the requested alpha event tag exactly', () => {
    const run = (args: string[]) => {
      if (args.join(' ') === 'rev-list -n 1 capgo-12.9.0-alpha.3')
        return alphaSha

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(resolveDeployTag('capgo-12.9.0-alpha.3', run)).toEqual({
      isAlpha: true,
      sha: alphaSha,
      tag: 'capgo-12.9.0-alpha.3',
    })
  })

  it.concurrent.each([
    'capgo-12.0',
    'capgo-12.0.0-alpha.latest',
    '--stable',
  ])('rejects malformed requested event tag %s', (tag) => {
    expect(() => resolveDeployTag(tag, () => stableSha)).toThrow(
      `Malformed Capgo deployment tag: ${tag}`,
    )
  })

  it.concurrent('rejects a requested tag that does not resolve to a commit', () => {
    expect(() => resolveDeployTag('capgo-12.9.0', () => '')).toThrow(
      'did not resolve to a full commit SHA',
    )
  })

  it.concurrent('accepts the requested tag only while it is current for its environment', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'rev-list -n 1 capgo-12.10.0': stableSha,
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.10.0\ncapgo-12.10.0-alpha.4',
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(assertCurrentDeployTag('capgo-12.10.0', run)).toEqual({
      isAlpha: false,
      sha: stableSha,
      tag: 'capgo-12.10.0',
    })
  })

  it.concurrent('rejects a stale requested tag without retargeting it', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'rev-list -n 1 capgo-12.9.0': stableSha,
        'rev-list -n 1 capgo-12.10.0': '3333333333333333333333333333333333333333',
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.10.0\ncapgo-12.9.0',
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(() => assertCurrentDeployTag('capgo-12.9.0', run)).toThrow(
      'Deployment tag capgo-12.9.0 is stale; current stable tag is capgo-12.10.0',
    )
  })

  it.concurrent('checks alpha freshness independently from stable tags', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'rev-list -n 1 capgo-12.10.0-alpha.4': alphaSha,
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.11.0\ncapgo-12.10.0-alpha.4',
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(assertCurrentDeployTag('capgo-12.10.0-alpha.4', run).tag).toBe('capgo-12.10.0-alpha.4')
  })

  it.concurrent('selects the most recently created stable tag despite an older higher version', () => {
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.10.0\ncapgo-13.0.0\ncapgo-13.0.0-alpha.2',
        'rev-list -n 1 capgo-12.10.0': stableSha,
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveLatestDeployTag(false, run)).toEqual({
      isAlpha: false,
      sha: stableSha,
      tag: 'capgo-12.10.0',
    })
    expect(calls[0]).toEqual([
      'tag',
      '--list',
      'capgo-[0-9]*',
      '--sort=-version:refname',
      '--sort=-creatordate',
    ])
  })

  it.concurrent('selects the newest alpha Capgo tag', () => {
    const run = (args: string[]) => {
      const key = args.join(' ')
      const responses: Record<string, string> = {
        'tag --list capgo-[0-9]* --sort=-version:refname --sort=-creatordate': 'capgo-12.10.0-alpha.4\ncapgo-13.0.0-alpha.10\ncapgo-12.10.0',
        'rev-list -n 1 capgo-12.10.0-alpha.4': alphaSha,
      }

      if (key in responses)
        return responses[key]

      throw new Error(`Unexpected git call: ${key}`)
    }

    expect(resolveLatestDeployTag(true, run)).toEqual({
      isAlpha: true,
      sha: alphaSha,
      tag: 'capgo-12.10.0-alpha.4',
    })
  })

  it.concurrent('rejects a missing deployment target', () => {
    expect(() => resolveLatestDeployTag(false, () => '')).toThrow(
      'No stable Capgo deployment tag was found',
    )
  })

  it.concurrent.each([
    [false, 'capgo-12.0'],
    [true, 'capgo-12.0.0-alpha.latest'],
  ])('rejects malformed deployment tags before checkout', (includePrereleaseTags, tag) => {
    const run = (args: string[]) => {
      if (args[0] === 'tag')
        return tag

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => resolveLatestDeployTag(includePrereleaseTags, run)).toThrow(
      `Malformed Capgo deployment tag: ${tag}`,
    )
  })

  it.concurrent('rejects a target that does not resolve to a full commit SHA', () => {
    const run = (args: string[]) => {
      if (args[0] === 'tag')
        return 'capgo-12.10.0'
      if (args[0] === 'rev-list')
        return 'deadbeef'

      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    }

    expect(() => resolveLatestDeployTag(false, run)).toThrow(
      'did not resolve to a full commit SHA',
    )
  })
})
