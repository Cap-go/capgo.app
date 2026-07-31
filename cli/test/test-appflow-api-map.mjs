import assert from 'node:assert'

const m = await import('../src/build/onboarding/appflow/api.ts')

assert.strictEqual(m.stripDataUri('data:application/x-pkcs12;base64,QUJD'), 'QUJD')
assert.strictEqual(m.stripDataUri('QUJD'), 'QUJD')
assert.strictEqual(m.bundleIdFromAppIdentifier('4TDEWHFV5T.com.aramco.cycomm'), 'com.aramco.cycomm')

const ios = m.mapIosSigning({
  cert_file: 'data:application/x-pkcs12;base64,Q0VSVA==',
  cert_password: 'NovaCerts',
  provisioning_profiles: [{ application_identifier: '4TDEWHFV5T.com.x.y', name: 'Prof', provisioning_profile_file: 'data:application/x-apple-aspen-mobileprovision;base64,UFJPRg==' }],
})
assert.strictEqual(ios.BUILD_CERTIFICATE_BASE64, 'Q0VSVA==')
assert.strictEqual(ios.P12_PASSWORD, 'NovaCerts')
assert.deepStrictEqual(JSON.parse(ios.CAPGO_IOS_PROVISIONING_MAP), { 'com.x.y': { profile: 'UFJPRg==', name: 'Prof' } })

const id = m.mapIosDistribution({ user_name: 'a@b.com', app_specific_password: 'w-x-y-z', apple_app_id: 1234, team_id: 'TEAM' })
assert.deepStrictEqual(id, { FASTLANE_USER: 'a@b.com', FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: 'w-x-y-z', APPLE_APP_ID: '1234', APP_STORE_CONNECT_TEAM_ID: 'TEAM' })

const and = m.mapAndroidSigning({ keystore_file: 'data:application/octet-stream;base64,S1M=', keystore_password: 'p1', key_password: 'p2', key_alias: 'al' })
assert.deepStrictEqual(and, { ANDROID_KEYSTORE_FILE: 'S1M=', KEYSTORE_STORE_PASSWORD: 'p1', KEYSTORE_KEY_PASSWORD: 'p2', KEYSTORE_KEY_ALIAS: 'al' })

const ad = m.mapAndroidDistribution({ json_key_file: 'data:application/octet-stream;base64,U0E=' })
assert.deepStrictEqual(ad, { PLAY_CONFIG_JSON: 'U0E=' })

const line = m.redactTrace('GET', 'https://api.ionicjs.com/apps/X/profiles/T/credentials/ios', 200, ['cert_file', 'cert_password'])
assert.ok(!line.includes('NovaCerts') && !line.includes('Q0VSVA=='), 'trace carries no secret values')
assert.ok(line.includes('200') && line.includes('credentials/ios'), 'trace carries method/url/status/shape')


// ── mappers OMIT absent fields (no literal "undefined"/"null" string values) ──
// (C11/C17/C21) A null/empty raw must NOT produce { APPLE_APP_ID: 'undefined', ... }.
const idEmpty = m.mapIosDistribution(null)
assert.deepStrictEqual(idEmpty, {}, 'null raw -> empty record, no fabricated keys')
const idPartial = m.mapIosDistribution({ user_name: 'a@b.com' })
assert.deepStrictEqual(idPartial, { FASTLANE_USER: 'a@b.com' }, 'absent app_specific_password/apple_app_id/team_id omitted')
assert.ok(!Object.values(idPartial).includes('undefined'), 'no literal "undefined" value')
assert.ok(!('APPLE_APP_ID' in idPartial), 'APPLE_APP_ID omitted when source absent (not "undefined")')

const sigEmpty = m.mapIosSigning(undefined)
assert.deepStrictEqual(sigEmpty, {}, 'undefined ios signing raw -> empty record')
const sigNoProfiles = m.mapIosSigning({ cert_file: 'data:application/x-pkcs12;base64,QkJC', cert_password: 'p' })
assert.deepStrictEqual(sigNoProfiles, { BUILD_CERTIFICATE_BASE64: 'QkJC', P12_PASSWORD: 'p' }, 'no provisioning_profiles -> CAPGO_IOS_PROVISIONING_MAP omitted')
assert.ok(!('CAPGO_IOS_PROVISIONING_MAP' in sigNoProfiles))

const andEmpty = m.mapAndroidSigning(null)
assert.deepStrictEqual(andEmpty, {}, 'null android signing raw -> empty record')
const adEmpty = m.mapAndroidDistribution(null)
assert.deepStrictEqual(adEmpty, {}, 'null android dist raw -> empty record')
console.log('api mapping + redaction OK')
