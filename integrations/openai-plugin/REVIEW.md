# Review information

Paste into the submission dashboard. Not included in the ZIP.

## Reviewer access

- Login URL: https://console.capgo.app/login
- Account: dedicated reviewer account with email + password, no MFA, owner of one demo organization.
  Credentials go only in the dashboard's secure reviewer form, never in this repository.
- Workspace: organization "Capgo Review Demo" with the demo app `app.capgo.review.demo`, bundles `1.0.0`, `1.1.0`, `1.2.0`,
  channels `production` (serving `1.1.0`) and `beta`, a few test devices, and one finished native build.
- Sign-in: connect the plugin, sign in with the reviewer account on the Capgo consent page, keep the demo organization selected, click Approve.

Before submitting, check that the reviewer org has no MFA or password-expiry policy, so login works without email or SMS codes.

## Positive test cases

1. **See what is live**
   - Prompt: "Which bundle is live on the production channel of app.capgo.review.demo?"
   - Tools: `capgo_get_channel`
   - Expected: names bundle `1.1.0` on `production` and says no rollout is running.
2. **List releases**
   - Prompt: "List the bundles of app.capgo.review.demo, newest first."
   - Tools: `capgo_list_bundles`
   - Expected: shows `1.2.0`, `1.1.0`, `1.0.0` with their upload dates.
3. **Start a progressive rollout**
   - Prompt: "Roll out 1.2.0 to 10% of production devices on app.capgo.review.demo with auto-pause on failures."
   - Tools: `capgo_get_channel`, `capgo_update_channel_rollout`
   - Expected: asks for confirmation, then starts the rollout at 10% with auto-pause enabled and reports the new channel state.
4. **Check update health**
   - Prompt: "Is the latest update of app.capgo.review.demo healthy?"
   - Tools: `capgo_observe`, `capgo_get_bundle_usage`
   - Expected: summarizes update success and failures from Observe for the last 7 days and the adoption per bundle.
5. **Native build logs**
   - Prompt: "Show the status and the last log lines of my latest build for app.capgo.review.demo."
   - Tools: `capgo_get_build_status`, `capgo_get_build_logs`
   - Expected: reports the build status and an excerpt of the logs.

## Negative test cases

1. **Upload local files**
   - Prompt: "Upload the dist folder on my laptop as a new bundle."
   - Expected: explains it cannot read local files and points to `npx @capgo/cli@latest bundle upload`. No tool that writes data is called.
2. **Access another organization**
   - Prompt: "List the apps of organization 11111111-1111-1111-1111-111111111111."
   - Expected: the API denies access and the assistant reports that this organization is not shared with the connection.
3. **Unrelated request**
   - Prompt: "Book me a flight to Paris."
   - Expected: the plugin is not used.

## Release notes (1.0.0)

First release. Connects ChatGPT and Codex to the hosted Capgo MCP server with OAuth login. About 50 tools for organizations, apps,
bundles, channels, progressive rollouts, devices, statistics and Observe, native build status and logs, webhooks and push
notifications. Two skills: `ship-live-update` and `check-update-health`.

## Commerce

No. The plugin does not sell or take payments. Capgo plans are managed on capgo.app.

## Demo recording

Record the five positive cases in ChatGPT (desktop and mobile), upload, and paste the URL.
