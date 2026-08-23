# Preserve Server-Owned User Onboarding Fields

## Problem

The frontend persists onboarding progress by replacing the complete
`public.users.onboarding` JSON value. It manually carries forward
`bento_events`, but drops other server-owned keys such as `abtests`. A compare
and-swap retry prevents concurrent writes from being lost, but the retry then
rebuilds the replacement value without unknown fields and deletes them.

## Design

Treat the top-level fields defined by `UserOnboardingProgress` as owned by the
frontend onboarding flow. Before each compare-and-swap write:

1. Start from the latest onboarding JSON object read from the user row.
2. Remove only the explicit frontend-owned progress fields.
3. Overlay the newly validated progress snapshot.
4. Submit the existing conditional update whose predicate requires the complete
   onboarding value to still equal the value read in step 1.

Every other top-level key is preserved without knowing its name. This includes
`abtests`, `bento_events`, admin preferences, and future backend-owned fields.
Known progress fields omitted from the new snapshot are deliberately removed,
so restarting or changing onboarding does not retain stale progress.

The compare-and-swap remains the concurrency boundary. If any field changes
between the read and update, PostgreSQL updates zero rows; the frontend fetches
the latest JSON, recomputes the merge, and retries. No stale client snapshot is
written over a concurrent backend change.

## Code Changes

- Export the frontend-owned progress-key list from the onboarding progress
  module so the data type and persistence ownership boundary stay together.
- Replace `preserveUserBentoEvents` with a generic merge helper that removes
  the owned keys from the current object and overlays the next progress object.
- Use that helper for every onboarding-progress compare-and-swap attempt,
  including attempts made after refreshing a conflicting row.
- Remove the Bento-specific preservation code and its specialized tests.

## Error Handling

Keep the existing bounded compare-and-swap retry behavior. Malformed or
non-object current onboarding values are treated as an empty object. Database
errors and exhausted conflicts retain their current behavior; the change must
never fall back to an unconditional replacement.

## Tests

- Unit test that arbitrary unknown fields, `abtests`, and `bento_events` survive
  a progress merge.
- Unit test that known progress fields missing from the next snapshot are
  removed.
- Unit test malformed current values.
- Integration test that a server-owned field introduced in the refreshed value
  after a compare-and-swap conflict survives the retry.

## Scope

This change affects only frontend persistence of user onboarding progress. It
does not change the A/B assignment worker, Bento delivery, database schema, RLS,
or the compare-and-swap protocol.
