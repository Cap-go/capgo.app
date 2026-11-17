# Billing usage retention and app ID reuse

This covers usage recorded by Capgo Cloud's own endpoints (updates, stats,
bundle downloads and builds). Traffic a customer routes to their own servers
through custom `updateUrl` / `statsUrl` plugin settings never reaches Capgo and
is out of scope.

Usage is stored per `app_id` in the daily tables (`daily_mau`,
`daily_bandwidth`, `daily_build_time`, `daily_storage_hourly`). These tables
have no foreign key to `apps`, so their rows outlive the app. The behaviors below are intentional:
they prevent resetting or hiding billable usage by deleting, recreating or
moving an app. Do not "fix" them without a product decision.

## Deleted apps stay billable for 35 days

- Deleting an app (dashboard, public API or CLI) keeps its daily usage rows and
  records the app in `deleted_apps` with its `owner_org`.
- `calculate_org_metrics_cache_entry` counts usage of the org's live apps
  **and** of its `deleted_apps`, so usage from before the deletion stays in
  the org's billing cycle.
- `delete_old_deleted_apps` purges `deleted_apps` rows older than 35 days, then
  purges the daily usage rows of those app IDs unless the app ID is live again
  or still held by another `deleted_apps` row.

## Storage is billed in GB-hours

Storage usage is the byte-hours each app's bundles were stored, per UTC day, in
`daily_storage_hourly` (`cron_stat_app` rebuilds the current cycle from
`version_meta` on every stats refresh). The billed value is the average stored
over the cycle, `get_org_storage_billable_bytes`:

```
billable bytes = sum(storage_byte_hours in the cycle) / hours in the cycle
```

So a plan with `storage` = 2 GB includes 2 GB x hours-in-cycle GB-hours.
Deleting bundles stops new hours from accruing but never removes hours already
used in the cycle, and the billed value only grows during a cycle.
Restoring a deleted bundle starts billing it again from the restore (a new
`version_meta.lifetime`, opened in the restoring transaction); the time it spent
deleted is not billed.

Rows are keyed by `(app_id, owner_org, cycle_start, date)` and a refresh only
replaces its own org's rows of its own cycle:

- **Org:** unlike the other daily tables, storage is attributed by
  `owner_org`, the org that owned the app when the hours were used. When a
  deleted app ID is recreated (or an app is transferred), the former org keeps
  its rows and its bill, and the new owner gets its own rows. Rows of deleted
  apps are kept until `delete_old_deleted_apps` purges them.
- **Cycle:** with a non-midnight anchor, the UTC day of the cycle boundary has
  one row per cycle. Billing counts a row when its `cycle_start` is inside the
  billed period, so each cycle bills only its own part of that day.

## Recreating a deleted app ID within 35 days

Any org may recreate an app ID that was deleted less than 35 days ago. This is
expected, and it has these consequences while the old `deleted_apps` row is
retained:

- **Usage is shared by app ID, not by app instance.** The recreated app reads
  and writes the same daily rows as the deleted one.
- **Both orgs are billed for that app ID's usage in their cycle.** The former
  owner is billed through its `deleted_apps` row, the new owner through its
  live app, and both sums cover the same daily rows (usage from before and
  after the recreation).
- **The new owner can see the former owner's retained usage.** Read policies on
  the daily tables check access through the live `apps` row with the same
  `app_id`, so members of the new org see aggregate MAU, bandwidth and build
  time for dates before the recreation. Only daily aggregates are exposed, not
  device-level data.

After the 35 days the old `deleted_apps` row is purged and only the live app is
billed. Because the app ID is live again, its daily rows are kept.

## App transfers count MAU for each org

`readDeviceUsageCF` groups devices by `(device_id, app_id, org_id)`. After an
app moves to another org, a device active under both the old and the new owner
in the same period is counted once per org, so moving an app cannot hide MAU.
