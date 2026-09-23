import { describe, expect, it } from 'vitest'
import { logRowDisplayMetadata, parseLogVersionName } from '~/services/logTableDisplay'

describe('parseLogVersionName', () => {
  it.concurrent('keeps a plain version unchanged', () => {
    expect(parseLogVersionName('2.36.2+8ebc69')).toEqual({
      version: '2.36.2+8ebc69',
      filename: null,
    })
  })

  it.concurrent('splits a manifest file failure into version and filename', () => {
    expect(parseLogVersionName('2.36.2+8ebc69:assets/index-8ebc69aabbcc.js')).toEqual({
      version: '2.36.2+8ebc69',
      filename: 'assets/index-8ebc69aabbcc.js',
    })
  })

  it.concurrent('ignores a trailing colon without a filename', () => {
    expect(parseLogVersionName('1.2.3:')).toEqual({
      version: '1.2.3',
      filename: null,
    })
  })
})

describe('logRowDisplayMetadata', () => {
  it.concurrent('returns null when there is no metadata and no filename', () => {
    expect(logRowDisplayMetadata('1.0.0', null)).toBeNull()
  })

  it.concurrent('keeps existing metadata when the version is plain', () => {
    expect(logRowDisplayMetadata('1.0.0', { source: 'notify_app_ready' })).toEqual({
      source: 'notify_app_ready',
    })
  })

  it.concurrent('puts a failed manifest filename into metadata', () => {
    expect(logRowDisplayMetadata('2.36.2:assets/main.js', null)).toEqual({
      filename: 'assets/main.js',
    })
  })

  it.concurrent('merges a failed manifest filename with existing metadata', () => {
    expect(logRowDisplayMetadata('2.36.2:assets/main.js', { error: 'timeout' })).toEqual({
      error: 'timeout',
      filename: 'assets/main.js',
    })
  })
})
