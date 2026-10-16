# Native iOS Sign in with Apple

The Apple button is available only on iOS binaries containing the SocialLogin plugin, when that frontend build sets `VITE_NATIVE_APPLE_LOGIN_ENABLED=true`. Web and Android keep their current login UI. Older iOS binaries cannot call the missing plugin. Native login sends an Apple identity token to the shared backend `/auth/apple` endpoint, which exchanges it with Supabase, with a random nonce whose SHA-256 hash is sent to Apple; Supabase verifies the original nonce. Existing MFA, SSO enforcement, disabled-account handling and onboarding remain in the login flow.

## Signing and provider setup

1. Enable Sign in with Apple on the existing Apple Developer App ID. The checked-in Xcode bundle identifier is `ee.forgr.capacitorgo`; verify it against the published app. The separate Capgo OTA app identifier is `ee.forgr.capacitor_go` and must not replace the Apple bundle identifier.
2. Regenerate the App Store Connect provisioning profile using the distribution certificate used by Builder. Update the matching entry in the GitHub Actions `CAPGO_IOS_PROVISIONING_MAP_BASE64` secret, preserving other targets. Existing certificate and upload API credentials can stay unchanged.
3. Enable the Apple provider in Supabase Auth and allow the native iOS bundle identifier as a client ID. Keep nonce verification enabled. No web Services ID or callback is needed for this iOS-only flow.
4. Create a Sign in with Apple key for the primary App ID, download its `.p8` private key, and record the key ID and developer team ID. This key is separate from the App Store Connect upload API key.
5. In the backend deployment secrets, set `APPLE_SIGN_IN_CLIENT_ID` (native bundle identifier), `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`, and `APPLE_SIGN_IN_PRIVATE_KEY` (PEM, actual or escaped newlines). These values stay on the server. The server generates short-lived client secrets for Apple token revocation.
6. Configure Apple's private email relay for Capgo's authentication email sender and verify OTP delivery to Hide My Email addresses. Email verification remains required for account deletion.
7. Both `VITE_NATIVE_APPLE_LOGIN_ENABLED` and `VITE_WEB_APPLE_LOGIN_ENABLED` explicitly default to `false` in the tracked Vite configuration. Opt in a frontend build with the corresponding local `.env.local` or build environment value set to `true`. Native visibility still requires real iOS and the SocialLogin plugin. No backend, Vault, private-config or provider-settings lookup decides button visibility. The backend is available whenever normal Apple credentials/configuration are present; there is no backend rollout switch. Existing Apple users can reauthenticate for deletion while the public native button is off.

## Account deletion

Apple accounts use the same account-deletion screen, with Apple reauthentication instead of a password. Email OTP, matching account identity, fresh authentication and any enrolled MFA remain required. Before scheduling deletion, the authenticated backend exchanges the fresh Apple authorization code, validates its signed identity token against the authenticated user's server-side Apple identity, and revokes the access token with Apple. Native codes and session tokens are never logged. The shared browser OAuth transport temporarily encrypts pending Apple credentials in restricted server storage; see [the shared API contract](apple-auth-api.md). The Apple sign-in must be less than five minutes old when revocation starts, including any time spent on MFA and confirmation. If it expires, restart Sign in with Apple; later MFA does not extend that window. A failed revocation leaves the account intact and asks the user to retry.

The existing delayed deletion and restoration policy remains in place. Authorization revocation does not delete the Capgo account by itself; deletion is scheduled through the existing user-scoped RPC.

## Release and verification

This backend/frontend change does not modify native projects, dependencies, versions or release workflows and does not require a new native build for an already compatible binary. A binary without the SocialLogin plugin or required Apple signing capability still needs separate native setup before native sign-in can work. Keep the public UI build flags false until the appropriate real-provider/device checks pass. Do not manually edit package versions or changelogs.

Verify first and returning authorization, relay email, cancellation, existing-email linking, MFA, SSO, disabled-account restoration, and same-account deletion/revocation in an operator-authorized environment. Backend validation and migration can be deployed independently of public button visibility.

For browser OAuth testing against a ready production backend, set `VITE_WEB_APPLE_LOGIN_ENABLED=true` only in your local frontend and use the exact approved HTTPS redirect described in [the shared contract](apple-auth-api.md#local-development-against-a-production-backend). This uses the real browser flow and changes no production frontend or backend setting.

The native app has no direct Supabase Apple token-exchange fallback, including deletion reauthentication. Apple names are sanitized, retained against the verified Apple identity across interrupted completion, and saved to the actual public profile without overwriting chosen names. Missing names remain optional and can be added in account settings. See [the cross-platform API contract](apple-auth-api.md) for OAuth consumers and rollout dependencies.
