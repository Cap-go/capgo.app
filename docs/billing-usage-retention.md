# Billing usage retention and app ID reuse

This covers usage recorded by Capgo Cloud's own endpoints (updates, stats,
bundle downloads and builds). Traffic a customer routes to their own servers
through custom `updateUrl` / `statsUrl` plugin settings never reaches Capgo and
is out of scope.

Usage is stored per `app_id` in the daily tables (`daily_mau`,
`daily_bandwidth`, `daily_build_time`). These tables have no foreign key to
`apps`, so their rows outlive the app. The behaviors below are intentional:
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
