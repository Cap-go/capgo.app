# Trial email suppression and lifecycle copy

## Problem and scope

The shared `org:legacy_stripe_trial_started` event starts both Trial and
Onboarding, including direct-offer signups that never had a trial. Do not filter
the backend event: ordinary onboarding depends on it.

Trial's send gates must check `offer=direct` immediately before each email.
Removing trial tags alone does not end an already-running workflow. Some later
gates also lacked the `plan:` prefix check used earlier in the flow.

`trial-email-suppression.liquid` is the tested replacement for all seven Magic
Split checks. **True must lead to End Session; False must lead to the existing
email.** It combines the existing paid markers, direct-offer suppression, and
the explicit onboarding opt-out.

This is a targeted suppression fix, not a new trial-entitlement system. Missing
tags retain the existing route. Trial-plan/card-on-file tags are not proof of
payment. The rule does not establish an active trial from timestamps, repair
missing billing tags, change delays, or resolve subscriber identity across
multiple organizations.

## Manual workflow rollout after review

Repository merge/deploy does not upload Liquid to Bento. The workflow change
must be applied separately in the Bento editor; the public workflow API is
[read-only](https://bentonow.com/docs/workflows_api).

1. Open the live **Trial** workflow and retain its current backup.
2. Replace the complete Liquid in every Magic Split below with
   [trial-email-suppression.liquid](trial-email-suppression.liquid).
3. Check each node's True → End Session and False → existing email connections.
   Keep the trigger, delays, email references, and existing sessions unchanged.
4. Save each changed node, save the workflow, then reopen every node to verify
   the persisted Liquid and connections.
5. Confirm the Onboarding workflow still uses the shared event and is unchanged.
   Do not start a run, replay events, or activate the draft lifecycle replacement.

| Existing Magic Split name | Replacement |
| --- | --- |
| Paid/customer before Half trial? | trial-email-suppression.liquid |
| Paid/customer before 3 days left? | trial-email-suppression.liquid |
| Paid/customer before ends today? | trial-email-suppression.liquid |
| Paid/customer before trial ended? | trial-email-suppression.liquid |
| Paid/customer before first subscription reminder? | trial-email-suppression.liquid |
| Paid/customer before second subscription reminder? | trial-email-suppression.liquid |
| Paid/customer before What was missing? | trial-email-suppression.liquid |

Apply all seven checks, not only an entry check: a contact may already be waiting
in a later delay. A message already queued by a Send Email action is outside this
gate's control. Read back the live nodes before declaring the rollout complete.
If rollback is needed, restore only these node conditions from the backup.

## Template changes

The HTML and exact subjects are versioned in
`supabase/templates/bento/lifecycle-copy.json`. Upload each referenced HTML and
subject together using Bento's template update tool, then fetch it again and
compare. These edits affect future renders only; they cannot change sent mail.

| Template | Change | Reason |
| --- | --- | --- |
| 110589 — post-trial value | Short intent-specific message and one “View Capgo plans” anchor | Replaces a long loss-focused feature list, unsupported timing/status claims, and nested button markup with a clear next step. |
| 85770 — bundle uploaded | Clear upload confirmation, bundle link with app-list fallback, visible notification controls | Distinguishes upload from deployment, removes draft-like jokes, and prevents incomplete event data producing an empty path. |
| 43121 — onboarding help | Reply-first setup question for native builds or live updates | The Support event also includes no-trial users. Removes the false trial-ended premise, extension promise, account-closure request, and homepage presented as a booking link. |

All three escape displayed names and include unsubscribe and preference links.
The help email remains reply-first; evaluate replies and activation, not only
click rate. Do not infer improved engagement until sufficient post-change data
exists.

### Publication status — 2026-11-16

All three template subjects and HTML bodies above were updated through Bento
MCP and fetched again; each matched the versioned source exactly. No email was
sent or replayed as part of verification. The Trial workflow gate replacement
is still pending the separate manual rollout described above.

### Synthetic before/after previews

These render the previous live copy and the replacement with fictitious names
and app identifiers. They verify local HTML layout, not inbox placement or
every email client's rendering. Both product-intent branches are covered by
the Liquid tests.

| Template | Desktop | Mobile |
| --- | --- | --- |
| Post-trial value | [Before/after](../pr-screenshots/bento-lifecycle/110589-desktop.png) | [Before/after](../pr-screenshots/bento-lifecycle/110589-mobile.png) |
| Bundle uploaded | [Before/after](../pr-screenshots/bento-lifecycle/85770-desktop.png) | [Before/after](../pr-screenshots/bento-lifecycle/85770-mobile.png) |
| Onboarding help | [Before/after](../pr-screenshots/bento-lifecycle/43121-desktop.png) | [Before/after](../pr-screenshots/bento-lifecycle/43121-mobile.png) |

## Verification

```sh
bunx vitest run tests/bento-trial-email-suppression.unit.test.ts tests/bento-lifecycle-copy.unit.test.ts
```

The tests render the actual Liquid, cover direct-offer contacts with stale trial
tags, each paid marker, preference opt-outs, and changes during a delay. They
also cover both product intents, missing bundle IDs, encoded links, and HTML
escaping. They do not send messages or exercise Bento's scheduler.

## Separate unresolved card-expiry coverage

The current `org:card_expiring` producer consumes `customer.source.expiring`.
[Stripe documents that this event excludes PaymentMethod API cards](https://docs.stripe.com/api/events/types#event_types-customer.source.expiring).
Before replacing this branch, reconcile expiring default cards and Stripe's
native reminder settings on both billing accounts. A new relative-delay ladder
started from an arbitrary invoice event could send inaccurate deadlines or
duplicate Stripe reminders. No card-expiry schedule is changed here.
