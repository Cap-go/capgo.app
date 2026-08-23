# New-user A/B test assignment

## Goal

Assign each eligible new user to a stable A or B branch during the existing
`on_user_create` backend flow, persist the assignment in `users.onboarding`, and
mirror the selected branch to Bento as a tag.

The first experiment is `new_emails`. It applies only to self-signups and sends
50% of them to each branch.

## Configuration

A checked-in JSON file is the source of truth for active experiments:

```json
{
  "new_emails": {
    "audience": "self_signup",
    "branch_a_percentage": 50,
    "branches": {
      "A": { "bento_tag": "ab:new_emails" },
      "B": { "bento_tag": "ab:no_new_emails" }
    }
  }
}
```

`audience` supports `self_signup` and `all`. A self-signup experiment excludes
records whose `created_via_invite` value is true. Removing an experiment from
the file stops assigning new users and does not alter existing assignments.

`branch_a_percentage` is an integer from 0 through 100. A random value below
that percentage selects A; all other values select B. Therefore 0 assigns every
eligible user to B, 50 splits users approximately evenly, and 100 assigns every
eligible user to A.

## Persistence and retry behavior

Assignments are stored without replacing unrelated onboarding data:

```json
{
  "abtests": {
    "new_emails": {
      "assigned_at": "2026-08-23T12:34:56.000Z",
      "branch": "A"
    }
  }
}
```

The backend writes only experiment keys that do not already exist. The database
update merges the `abtests` object atomically so concurrent onboarding writes
and queue retries do not overwrite unrelated state or reroll an assignment.
Existing assignments are authoritative even if configuration percentages later
change.

Assignment is persisted before Bento delivery. If Bento delivery fails, the
user-create queue item fails and retries; the retry reads and reuses the stored
branch.

## Bento synchronization

For every eligible configured experiment, the handler sends the selected
branch tag and removes the opposite branch tag in one subscriber-tag sync.
For `new_emails`, A adds `ab:new_emails` and removes `ab:no_new_emails`; B does
the reverse. Bento being unconfigured remains a successful no-op, matching the
existing Bento utility contract. A configured Bento rejection fails the queue
item so it can retry.

## Code boundaries

A focused backend utility owns configuration validation, audience matching,
random branch selection, atomic persistence, and Bento tag-delta construction.
The existing `on_user_create` handler calls it after new-user eligibility is
confirmed. No schema migration or new database function is required.

## Verification

Unit tests cover random values on both sides of the 50% boundary, 0% and 100%
allocations, self-signup versus invited-user audiences, preservation of
unrelated onboarding JSON, reuse of existing assignments, selected/opposite
Bento tags, and configured Bento failures. Existing user-create lifecycle tests
continue to cover route-level queue behavior.
