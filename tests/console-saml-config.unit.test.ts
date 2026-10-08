import { expect, it } from 'vitest'
import { consoleSamlConfig } from '../supabase/functions/_backend/utils/console_sso.ts'

it.each([
  '<broken',
  '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com"/>',
  '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x/>',
  'x'.repeat(262145),
])('rejects invalid SAML metadata with a client error', (xml) => {
  expect(() => consoleSamlConfig('https://api.example.com', 'fixture-provider', xml)).toThrow(expect.objectContaining({ status: 400 }))
})
