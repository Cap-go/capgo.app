# Weekly activity email

`weekly_stats.bento.html` is the Bento template for `user:weekly_stats` (template
43123). Repository edits do not upload it automatically. Update the live template
before deploying the backend: the legacy branch intentionally omits the old
`weekly_open` field and does not guess the historical reporting dates.

The backend sums `daily_version` counters for one app over seven completed UTC
days, using the same explicit range in SQL and email metadata. `get` counts update
checks, not app opens or users. `install` and `fail` are independent event counters,
not matched outcomes of unique update attempts. Counts can be sampling estimates.
Do not derive a release success rate or unique-device adoption from these totals.

The legacy `get_weekly_stats` RPC remains unchanged for existing clients; the
email uses an indexed, parameterized aggregate with accurate column names.
The separate first-24-hour deployment email is not changed by this template.
