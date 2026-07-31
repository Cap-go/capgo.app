// src/build/onboarding/android/oauth-scopes.ts
import { GOOGLE_OAUTH_SCOPES_ANDROIDPUBLISHER } from './oauth-google.js'

/** OAuth scopes for Capgo Android onboarding — androidpublisher (Play) plus
 *  cloud-platform (create GCP projects / service accounts / keys), and the
 *  OPTIONAL playdeveloperreporting scope used by the app-existence verification
 *  step (apps:search). Shared by the Ink wizard and the MCP bridge so the two
 *  drivers can never drift. */
export const OAUTH_SCOPES_FOR_ONBOARDING = [
  ...GOOGLE_OAUTH_SCOPES_ANDROIDPUBLISHER,
  'https://www.googleapis.com/auth/cloud-platform',
  // OPTIONAL — declining it on the consent screen must NOT fail sign-in (it is
  // excluded from OAUTH_REQUIRED_SCOPES; see splitMissingScopes in
  // oauth-google.ts). The app-existence verify step degrades to the plain
  // Gradle picker without it.
  'https://www.googleapis.com/auth/playdeveloperreporting',
] as const

/** The subset of {@link OAUTH_SCOPES_FOR_ONBOARDING} whose absence must FAIL
 *  sign-in. Excludes the optional playdeveloperreporting scope so a user who
 *  declines app-listing still completes onboarding (graceful degradation). */
export const OAUTH_REQUIRED_SCOPES = [
  ...GOOGLE_OAUTH_SCOPES_ANDROIDPUBLISHER,
  'https://www.googleapis.com/auth/cloud-platform',
] as const
