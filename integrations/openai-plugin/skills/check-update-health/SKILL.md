---
name: check-update-health
description: Check how a Capgo live update is performing on devices using Observe, statistics and device data.
---

Use this workflow when the user asks whether an update is healthy, why devices are not updating, or how many users are on a version.

1. Resolve the app ID with `capgo_list_apps` if it was not given.
2. Call `capgo_observe` with `view: "summary"` and a `days` window that fits the question (default 7). Report the findings it returns.
3. Follow up only where the summary points:
   - Failing updates: `capgo_observe` with `view: "events"` and `action: "update_fail"`, or `view: "versions"` for one bundle.
   - Adoption: `capgo_get_bundle_usage` for the share of devices per bundle.
   - One device: `capgo_list_devices` or `capgo_get_device`, then `capgo_observe` with `view: "device"` and its `deviceId`.
4. Compare with the live channel from `capgo_get_channel`, so the user can see whether the problem bundle is the one being served.
5. Summarize in plain language: what is wrong, how many devices it affects, and the next step. When the next step is a rollback or pause, describe it and let the user decide; do not change channels from this workflow.

This workflow is read-only. Do not call tools that change data.
