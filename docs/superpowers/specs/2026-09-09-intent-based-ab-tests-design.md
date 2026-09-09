# Intent-Based Onboarding A/B Tests

## Summary

Extend the backend onboarding A/B test system so an experiment can optionally
target an exact set of onboarding intents. Intent-gated experiments remain
unassigned until the authenticated user's persisted onboarding intent is one of
the configured values. When the endpoint is called after the intent changes, it
removes assignments that no longer match before assigning any newly eligible
experiments.

No active experiment will use intent targeting in this change. Existing
experiments and their assignments keep their current behavior.

## Goals

- Let an A/B test declare a non-empty list of eligible onboarding intents.
- Match intents exactly. For example, an experiment configured for `ota` does
  not include `both` unless `both` is listed explicitly.
- Do not assign an intent-gated experiment before a supported intent is
  persisted in `users.onboarding.intent`.
- Reconcile persisted assignments when the authenticated user asks for their
  onboarding experiments.
- Remove Bento experiment tags when an assignment is revoked.
- Keep assignment and revocation decisions atomic under concurrent requests.

## Non-goals

- Do not enable intent targeting for an existing experiment.
- Do not change the frontend in this pull request.
- Do not add a database trigger or a new intent-write endpoint.
- Do not reinterpret `both` as implicitly matching `ota` or `builder`.
- Do not change branch allocation percentages or audience semantics.

## Configuration

An experiment may add an optional `intents` property to
`supabase/functions/_backend/utils/ab_tests.json`:

```json
{
  "future_ota_experiment": {
    "audience": "self_signup",
    "intents": ["ota", "both"],
    "treatment_percentage": 50,
    "treatment_branch": "A",
    "control_branch": "B",
    "branches": {
      "A": { "bento_tag": "ab:future_ota_experiment" },
      "B": { "bento_tag": "ab:no_future_ota_experiment" }
    }
  }
}
```

`intents` is optional. When absent, the experiment is not intent-gated. When
present, it must be a non-empty array of unique supported onboarding intents:
`ota`, `builder`, `both`, `exploring`, or `publish`. Unknown values, duplicates,
and empty arrays make the configuration invalid at startup.

## Eligibility

Eligibility is the intersection of all configured conditions:

1. The user matches the existing audience rule.
2. If `intents` is present, `users.onboarding.intent` is a supported string and
   exactly equals one of its values.

An absent or invalid persisted intent never matches an intent-gated
experiment. It does not affect experiments without `intents`.

The user-creation trigger continues to assign non-intent experiments. Since a
new user has not selected an intent yet, it skips all intent-gated experiments.

## Request-Time Reconciliation

`POST /private/onboarding_ab_tests` remains parameterless and authenticated.
The backend treats `users.onboarding.intent` as the source of truth rather than
accepting a caller-supplied intent.

The replica fast path reads the audience fields, persisted intent, and stored
assignments. It may return immediately only when every eligible experiment has
a valid assignment and no stored intent-gated assignment is now ineligible.
Otherwise, the request falls back to the primary database.

On the primary database, one transaction locks the user row and then:

1. Recomputes eligible experiment names from the locked row.
2. Identifies stored intent-gated assignments that are no longer eligible.
3. Preserves valid eligible assignments and all unrelated onboarding fields.
4. Creates assignments only for eligible experiments that are still missing.
5. Removes revoked keys and adds new assignments in one `users.onboarding`
   update.
6. Returns only the complete, currently eligible assignment map.

The row lock ensures two simultaneous requests cannot generate competing
branches or lose a concurrent reconciliation decision.

## Bento Synchronization

After the database transaction commits, the endpoint performs one best-effort
Bento tag synchronization:

- Newly created assignments add the selected branch tag and remove the
  opposite branch tag, preserving current behavior.
- Revoked assignments remove both branch tags for that experiment. Removing
  both is idempotent and also cleans up any historical tag drift.

A Bento failure is logged but does not restore an ineligible database
assignment or fail the otherwise successful endpoint response, matching the
existing on-demand synchronization policy.

## Frontend Contract

The response shape remains `{ "assignments": { ... } }`. The returned map is
authoritative for the user's currently eligible experiments.

A future frontend that enables an intent-gated experiment must:

1. Persist the selected intent.
2. Call `POST /private/onboarding_ab_tests` after that write completes.
3. Replace its local assignment map with the response instead of merging it,
   so revoked assignments disappear in the same session.

That frontend work is intentionally outside this backend-only pull request.

## Testing

Unit coverage will verify:

- `intents` accepts unique supported values and rejects empty, duplicate, or
  unsupported values.
- Exact intent matching, including that `ota` does not implicitly match
  `both`.
- Intent-gated experiments are skipped when intent is absent or invalid.
- Non-intent experiments keep their current signup and on-demand behavior.
- The replica fast path is used only for a complete, eligible, non-stale set.
- The primary transaction creates newly eligible assignments and preserves
  existing eligible assignments.
- Changing or clearing intent revokes only now-ineligible intent-gated
  assignments.
- Revocation and creation can happen in the same transaction.
- Bento synchronization adds new branch tags and removes both tags for revoked
  experiments.
- The authenticated endpoint keeps its existing request and response shape.

The existing backend lint, typecheck, and unit suites provide regression
coverage. No schema migration or PostgreSQL function is required.
