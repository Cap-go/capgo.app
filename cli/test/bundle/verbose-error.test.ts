import { describe, expect, it } from 'bun:test'
import { formatVerboseError } from '../../src/utils'

describe('verbose upload error formatting', () => {
  it('renders tus and native fetch cause chains with transport details', () => {
    const transportError = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
      address: '203.0.113.10',
      port: 443,
    })
    const fetchError = new TypeError('fetch failed')
    Object.defineProperty(fetchError, 'cause', { value: transportError })
    const tusError = Object.assign(new Error('tus: failed to upload chunk'), {
      causingError: fetchError,
    })

    expect(formatVerboseError(tusError)).toBe([
      'Error: tus: failed to upload chunk',
      '  Caused by: TypeError: fetch failed',
      '    Caused by: ConnectTimeoutError: Connect Timeout Error (code=UND_ERR_CONNECT_TIMEOUT, address=203.0.113.10, port=443)',
    ].join('\n'))
  })

  it('renders aggregate transport errors without serializing request objects', () => {
    const aggregateError = Object.assign(new Error('connection attempts failed'), {
      name: 'AggregateError',
      code: 'ECONNREFUSED',
      errors: [
        Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 443 }),
      ],
      originalRequest: {
        headers: { 'X-Capgo-Upload-Token': 'must-never-be-logged' },
      },
    })

    const formatted = formatVerboseError(aggregateError)
    expect(formatted).toContain('AggregateError: connection attempts failed (code=ECONNREFUSED)')
    expect(formatted).toContain('Contained error 1: Error: connect refused (code=ECONNREFUSED, address=127.0.0.1, port=443)')
    expect(formatted).not.toContain('must-never-be-logged')
    expect(formatted).not.toContain('originalRequest')
  })

  it('redacts credentials that appear inside an error message', () => {
    const formatted = formatVerboseError(new Error('request failed token=supersecret Authorization: Bearer header.secret.value'))

    expect(formatted).toContain('token=[REDACTED]')
    expect(formatted).toContain('Authorization: Bearer [REDACTED]')
    expect(formatted).not.toContain('supersecret')
    expect(formatted).not.toContain('header.secret.value')
  })
})
