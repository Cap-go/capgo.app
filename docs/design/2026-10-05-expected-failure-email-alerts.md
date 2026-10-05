# Design note: expected-failure product emails (audit)

**Status:** HOLD for product pick (Martin via Jose/Charly). No implementation in this change set.

**Context:** Customers who intentionally gate OTA (native mismatch, channel strategy, self-assign policy) still receive alarming operational emails. Related thread: Discord "Cannot Opt Out of Emails" (Matt). Public footer now uses Bento `uuid` instead of email in URLs; preference persistence must stay correct after that fix.

**Scope audited:** `Cap-go/capgo.app` backend + console preference surfaces. Bento email **subjects and HTML bodies** live in Bento automations (not in this repo). One in-repo copy reference: `supabase/functions/_backend/emails/channel_self_set_rejected.md`.

---

## Trigger inventory

### 1. Device update policy blocks (`device_error`)

| Field | Detail |
| --- | --- |
| **Bento events** | `device:upgrade_blocked`, `device:downgrade_blocked` |
| **Where it fires** | `POST /updates` (`plugin_runtime/utils/update.ts` → `notifyAutoUpdateVersionBlocked`) when channel policy blocks the target bundle: major / minor / patch / metadata (`disable_auto_update`) or `under_native` (`disable_auto_update_under_native`). |
| **Not emailed** | Other update errors (private channel without self-assign, disabled platform, disable_device, key mismatch, etc.) only record stats; no `device_error` email. |
| **Tone (console)** | Settings label: "Device update errors"; description: "Receive emails when devices fail to update" (`messages/en.json`). Reads like an outage, but many triggers are **expected** when natives lag channel bundles. |
| **Tone (Bento)** | Not in repo. Payload fields documented in `docs/BENTO_EMAIL_PREFERENCES_SETUP.md` (app, device, channel, versions, `reason`). |
| **Rate limit / digest** | `sendNotifToOrgMembersCached` with cron `0 0 * * 0` (weekly, Sunday midnight). `uniqId` = **`app_id` only** (one slot per app per week for all block reasons combined). Production: queued via plugin KV (`plugin_notification_queue.ts`), then `notifications` table + edge cache for throttle. |
| **Preference key** | `device_error` |
| **Checked before send?** | **Yes (Capgo DB):** `getEligibleOrgMemberEmails` / org `email_preferences` in `org_email_notifications.ts`. Missing key = enabled. |
| **Bento tag gate** | `device_error_disabled` when user opts out (`user_preferences.ts`). Documented for automations in `BENTO_EMAIL_PREFERENCES_SETUP.md`. |
| **Public footer opt-out** | Yes (`email-preferences.vue`, `private/email_preferences.ts`). |
| **Org management email** | Yes, if org pref enabled (default on). |

**Matt-relevant:** `under_native` and version-policy blocks while users still run an older store build are **by design** but still eligible for weekly `device_error` mail.

---

### 2. Incompatible native bundle (`bundle_incompatible` / `bundle_incompatible_expected`)

| Field | Detail |
| --- | --- |
| **Bento events** | `bundle_incompatible` (warning), `bundle_incompatible_expected` (informational when channel strategy already keeps bundle off outdated natives) |
| **Where it fires** | CLI `Bundle Incompatible` tracking → `POST /private/events` → `buildBundleIncompatibleBentoEvent` (`private/events.ts` + `bundle_compatibility_recovery.ts`). Only when upload **overwrote** the channel live version (`channel_overwritten`). Skipped if `--accept-incompatible` / `incompatibility_accepted`. |
| **Tone (console)** | "Incompatible bundles" / "may need a native app store update" (`messages/en.json`). |
| **Tone (Bento)** | Not in repo. `bundle_incompatible_expected` is meant to be calmer; copy is automation-side. |
| **Rate limit / digest** | `sendNotifToOrgMembersOnce` (`once: true`). `uniqId` = `{event}:{app_id}:{channel}:{version_new_name}` (per version, not repeating retries). Default Bento cron in `sendNotifToOrgMembers` is `* * * * *` but **once path bypasses cron window**. |
| **Preference keys** | `bundle_incompatible` and separate `bundle_incompatible_expected` |
| **Checked before send?** | **Yes (Capgo DB)** per event's `preferenceKey`. |
| **Bento tags** | `bundle_incompatible_disabled`, `bundle_incompatible_expected_disabled` |
| **Public footer** | API allows both keys; **footer UI only lists `bundle_incompatible`** (not `_expected`). Logged-in settings same: one toggle for warning only. |
| **Org `email_preferences` default** | Does **not** include `bundle_incompatible` keys; missing = enabled for management email. |

**Gap:** Users cannot opt out of "expected" informational mail separately in the console footer UI even though backend supports `bundle_incompatible_expected`.

---

### 3. Channel self-assignment rejected (`channel_self_rejected`)

| Field | Detail |
| --- | --- |
| **Bento event** | `device:channel_self_set_rejected` |
| **Where it fires** | `POST` / `DELETE` `/channel_self` when target channel has `allow_device_self_set = false` (`plugin_runtime/plugins/channel_self.ts`). Legacy server-side override paths; new plugins store channel locally and may not hit these branches as often. |
| **Related (same preference key)** | `plugin:legacy_channel_upgrade` also uses preference `channel_self_rejected` with **daily** cron `0 0 * * *` and `uniqId` `legacy-plugin-upgrade` (legacy plugin upgrade nudge). |
| **Tone (in-repo example)** | Subject: "Device **blocked** from channel self-assignment in {app}" (`emails/channel_self_set_rejected.md`). Body: "tried to switch to a channel that doesn't allow self-assignment." Footer: at most one per app per week. |
| **Rate limit** | Weekly `0 0 * * 0`, `uniqId` = `app_id`. |
| **Preference key** | `channel_self_rejected` |
| **Checked before send?** | **Yes (Capgo DB).** |
| **Bento tag** | `channel_self_rejected_disabled` |
| **Bento setup doc** | **Not listed** in `BENTO_EMAIL_PREFERENCES_SETUP.md` (automation filter may be missing). |
| **Public footer** | Yes. |

---

### 4. Related: daily high install **fail ratio** (`daily_fail_ratio`) (bundle failures aggregate)

Not requested by name but matches "bundle failure" flooding when many devices fail OTA for expected reasons.

| Field | Detail |
| --- | --- |
| **Bento event** | `app:daily_fail_ratio` |
| **Where it fires** | Cron `process_daily_fail_ratio_email` (yesterday `daily_version`, fail rate >= 30%, installs >= 10) → `cron_email` → `handleDailyFailRatio`. |
| **Tone** | Not in repo. Metadata: fail %, installs, app name. |
| **Rate limit** | **No** `notifications` row throttle; can queue **every cron day** while condition holds. `sendEmailToOrgMembers` (not Cached/Once). |
| **Preference key** | `daily_fail_ratio` |
| **Console / footer UI** | **No toggle** in account or public footer (only in `email_preferences.ts` sanitize list for unsubscribe-all). Default missing = enabled. |
| **Checked before send?** | **Yes (Capgo DB)** for admins; org management email if org pref missing = enabled. |

---

## Preference enforcement stack (current)

1. **Capgo Postgres** `users.email_preferences` and `orgs.email_preferences` filtered in `org_email_notifications.ts` before `trackBentoEvent`.
2. **Bento subscriber tags** `_disabled` synced on user update (`syncUserPreferenceTags`).
3. **Bento automations** must exclude tags (documented for `device_error` only among this set; gaps for `channel_self_rejected`, `bundle_incompatible*`, `daily_fail_ratio`).
4. **Public footer** (`/email-preferences?uuid=`): opt-out only; resolves email via Bento UUID; updates Capgo user row when found; syncs tags; `unsubscribe_all` calls Bento unsubscribe.

**UUID / stickiness (after privacy footer):** Saving with `uuid` resolves the subscriber email in Bento, then merges opt-outs into `users.email_preferences` and re-syncs tags. Non-Capgo emails only get Bento unsubscribe on "unsubscribe all", not granular keys. Verification after UUID fix: integration test matrix in `tests/email-preferences.test.ts` plus manual: opt out `device_error` via uuid footer, confirm DB false, Bento tag present, and no `trackBentoEvent` recipient for that user on next queued notification.

---

## Product options (pick one direction or combine)

### (A) Quieter defaults

**What changes**

- Default new and existing users/orgs to **off** (or off for "expected" subclasses only) for `device_error`, `channel_self_rejected`, and/or `bundle_incompatible`.
- Optionally split `device_error` into "policy block (expected)" vs "true failure" if we can classify reliably.

**Risks**

- Miss real misconfigurations (channel strategy wrong, accidental native break).
- Migration noise: existing customers may think alerts broke.

**Preference verification**

- Ship migration for JSONB defaults; on save still call `syncUserPreferenceTags`; add e2e: default-off user receives no Bento event when simulated `/updates` block fires.

---

### (B) Digest / rate-limit expected failures

**What changes**

- Keep defaults on but tighten delivery: e.g. daily digest per org, spike detection (only alert when fail ratio or block count jumps vs 7-day baseline), merge `device_error` reasons into one weekly summary with counts by `reason`.
- Apply `sendNotifToOrgMembersCached` or Once semantics to `daily_fail_ratio`; add dedupe key per app per day.

**Risks**

- Engineering complexity on hot paths (`/updates` must stay queue-only on Cloudflare).
- Delayed signal for genuine incidents.

**Preference verification**

- Unchanged keys; test that throttled digest still respects per-user `device_error: false` and Bento tags after uuid footer save.

---

### (C) Softer copy only (keep volume)

**What changes**

- Bento templates + in-repo `channel_self_set_rejected.md` and console strings: replace "blocked", "failure", "error" with neutral language ("update held by channel policy", "self-assignment not enabled on this channel", "compatibility notice").
- Clarify in body that this can be normal during native rollouts.

**Risks**

- Does not reduce volume; Matt-like cases still get weekly mail if prefs stay on.
- Bento-only copy drift unless automations are versioned/checklisted.

**Preference verification**

- Copy-only; still run footer uuid opt-out regression tests so scaries do not push users to broken unsubscribe flows.

---

## Recommended next step

**HOLD implementation.** Choose A, B, C, or a hybrid (e.g. B + C). After pick:

1. Update Bento automations and `docs/BENTO_EMAIL_PREFERENCES_SETUP.md` for all events in this audit.
2. Align console + public footer toggles with backend keys (including `bundle_incompatible_expected`, consider `daily_fail_ratio` UI).
3. Add classification for expected vs unexpected where the product already knows (`bundle_incompatible_expected`, gated `device_error` reasons).

---

## Audit notes / bugs (non-blocking, for later)

- `plugin:legacy_channel_upgrade` shares `channel_self_rejected` preference though event semantics differ.
- Bento automation filters undocumented for several keys in this audit.
- `email-preferences.vue` omits `bundle_incompatible_expected` though API supports it.
- `daily_fail_ratio` emails lack user-facing opt-out and daily dedupe.

Generated with AI (audit pass).
