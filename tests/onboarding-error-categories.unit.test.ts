import { describe, expect, it } from 'vitest'
import { MissingScopesError } from '../cli/src/build/onboarding/android/oauth-google.ts'
import { CertificateLimitError } from '../cli/src/build/onboarding/apple-api.ts'
import { mapAndroidOnboardingError, mapIosOnboardingError, mapSaValidationKindToCategory } from '../cli/src/build/onboarding/error-categories.ts'

const httpError = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra)

describe('mapIosOnboardingError', () => {
  it.concurrent.each([
    ['401 from App Store Connect', httpError('Unauthorized', { status: 401 }), undefined, 'apple_api_unauthorized'],
    ['403 with the agreements code', httpError('Apple API error (403): A required agreement is missing or has expired. — sign it (FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED)', { status: 403, code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED' }), undefined, 'apple_agreements_missing'],
    ['403 agreements error by message only', httpError('A required agreement is missing or has expired.', { status: 403 }), undefined, 'apple_agreements_missing'],
    // The iOS TUI collapses the AppleApiHttpError to a plain Error(message): no status/code survive.
    ['friendly agreement message with status/code stripped', new Error('Apple is blocking App Store Connect API access because your developer account has a required agreement that is unsigned or has expired.\n  - Sign in as the Account Holder at https://appstoreconnect.apple.com'), 'verifying-key', 'apple_agreements_missing'],
    // "required agreement" must sit next to a signing/expiry word; loose mentions stay forbidden.
    ['unrelated 403 loosely mentioning agreement', httpError('Forbidden: your team agreement role is insufficient', { status: 403 }), undefined, 'apple_api_forbidden'],
    ['other 403s', httpError('Forbidden', { status: 403 }), undefined, 'apple_api_forbidden'],
    ['429', httpError('Too many', { status: 429 }), undefined, 'apple_api_rate_limited'],
    ['CertificateLimitError', new CertificateLimitError([]), undefined, 'cert_limit_reached'],
    ['profile creation failures', httpError('Profile create failed', { phase: 'profile' }), undefined, 'profile_creation_failed'],
    ['P8 read errors', httpError('Cannot parse P8', { phase: 'p8' }), undefined, 'p8_invalid'],
    ['import-scanning failures', new Error('no identities'), 'import-scanning', 'keychain_no_identities'],
    ['import-exporting failures', new Error('wrong password'), 'import-exporting', 'keychain_export_failed'],
    ['import-provide-profile-path failures', new Error('fs error'), 'import-provide-profile-path', 'profile_read_failed'],
    ['import-pick-profile', new Error('no match'), 'import-pick-profile', 'profile_no_match'],
    ['import-no-match-recovery', new Error('no match'), 'import-no-match-recovery', 'profile_no_match'],
    ['a 401 during an import step (structural discriminators win)', httpError('Unauthorized', { status: 401 }), 'import-scanning', 'apple_api_unauthorized'],
    ['an unknown error', new Error('something else'), undefined, 'unknown'],
    ['a string', 'a string', undefined, 'unknown'],
    ['undefined', undefined, undefined, 'unknown'],
    ['a non-import welcome step', new Error('???'), 'welcome', 'unknown'],
    ['a non-import creating-certificate step', new Error('???'), 'creating-certificate', 'unknown'],
  ] as const)('maps %s', (_label, error, failedStep, expected) => {
    expect(mapIosOnboardingError(error, failedStep as never)).toBe(expected)
  })
})

describe('mapAndroidOnboardingError', () => {
  it.concurrent.each([
    ['MissingScopesError', new MissingScopesError(['scope1'], ''), 'google_oauth_failed'],
    ['keystore parse failures', httpError('Bad keystore', { phase: 'keystore' }), 'keystore_invalid'],
    ['oauth token failures', httpError('Token refresh failed', { phase: 'oauth' }), 'google_oauth_failed'],
    ['play account id failures', httpError('Bad ID', { phase: 'play_account_id' }), 'play_account_id_invalid'],
    ['an unknown error', new Error('???'), 'unknown'],
    ['null', null, 'unknown'],
  ] as const)('maps %s', (_label, error, expected) => {
    expect(mapAndroidOnboardingError(error)).toBe(expected)
  })
})

describe('mapSaValidationKindToCategory', () => {
  it.concurrent.each([
    ['shape-error', 'sa_json_shape_invalid'],
    ['token-error', 'sa_json_token_rejected'],
    ['no-app-access', 'sa_json_no_app_access'],
    ['network-error', 'sa_json_network_error'],
  ] as const)('maps %s to %s', (kind, expected) => {
    expect(mapSaValidationKindToCategory(kind)).toBe(expected)
  })
})
