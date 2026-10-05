---
name: ship-live-update
description: Deploy an already uploaded Capgo bundle to a channel, directly or as a progressive rollout, and roll it back if needed.
---

Use this workflow when the user wants to ship, roll out, promote or roll back a live update.

1. Find the app. If the user did not give an app ID, call `capgo_list_apps` and ask which one when there is more than one.
2. Find the bundle with `capgo_list_bundles`. The newest bundle is first and each page holds 50 bundles, so keep reading the next `page` until you find it or a page comes back with fewer than 50. Only when it is in no page, explain that new bundles are uploaded with the Capgo CLI (`npx @capgo/cli@latest bundle upload`) and stop.
3. Read the target channel with `capgo_get_channel` (or `capgo_list_channels`) and tell the user which bundle is live now and whether a rollout is already running.
4. Pick the deploy mode:
   - Full deploy: `capgo_update_channel` with `version` set to the bundle name.
   - Progressive rollout: `capgo_update_channel_rollout` with `rolloutVersion`, `rolloutPercentage` and `rolloutEnabled: true`. Suggest `autoPauseEnabled: true` so the rollout pauses on failures.
     Before calling either tool, state the app, channel, bundle and percentage, and wait for the user to confirm. These calls change what real devices download.
5. To change a running rollout, call `capgo_update_channel_rollout` with `appId` and `channel`, plus only the rollout fields that change: `rolloutPercentage`, `rolloutPaused`, `promoteToStable: true` or `rollback: true`. Describe the change and wait for the user to confirm first, like in step 4.
6. After a change, call `capgo_get_channel` again and report the resulting state.

Never delete bundles or channels as part of a deploy. If a call returns an error, show the error message and do not retry with different settings unless the user asks.
