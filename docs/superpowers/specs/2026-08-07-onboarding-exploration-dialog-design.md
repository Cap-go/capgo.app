# Onboarding Exploration Dialogue Design

## Problem

An unfinished onboarding user who has already confirmed that they want to explore Capgo sees the persistent “Exploring the Capgo dashboard” banner. Clicking the Dashboard sidebar item nevertheless opens the exploration confirmation dialogue again.

The sidebar currently uses the presence of an onboarding resume app ID as the confirmation trigger. Outside `/app/new`, that ID comes from the active in-memory exploration grant, so the code mistakes “already exploring” for “needs confirmation.”

## Desired behavior

- Keep redirecting unfinished onboarding users back to `/app/new` after a full page reload.
- Keep the in-memory exploration grant; do not persist it in browser storage.
- Keep the exploration banner visible while setup remains incomplete.
- Ask for confirmation before the user starts exploring.
- Do not ask again while the same in-memory exploration grant is active.
- Keep the banner’s “Continue with setup” action unchanged.

## Approach

Import `canExploreOnboardingDashboard` into the sidebar. When deciding whether the Dashboard item needs confirmation, require all of the following:

1. The destination is `/dashboard`.
2. A resumable onboarding app is known.
3. The current user has not already received the in-memory exploration grant.

This is preferred over limiting the dialogue only to `/app/new`, because onboarding-related navigation may temporarily pass through routes such as API Keys. It is also preferred over introducing a new state model because the existing grant already represents the required distinction.

## Testing

Add focused regression coverage around the sidebar decision:

- A pending onboarding user without an exploration grant is asked to confirm before opening Dashboard.
- A user with an active exploration grant navigates directly to Dashboard without seeing the dialogue.
- Existing onboarding redirect tests continue proving that the grant disappears after a module reload, preserving the original return-to-onboarding behavior.

Run the focused unit tests, frontend lint, and frontend typecheck after implementation.

## Scope

No changes to `sessionStorage`, the auth redirect guard, the banner lookup, onboarding persistence, organization creation, or unrelated navigation behavior.
