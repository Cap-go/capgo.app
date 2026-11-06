# CI/CD onboarding tracking

The console guides users to automate releases at `/app/APP_ID/ci-cd`. The
sidebar keeps a **Set up CI/CD** entry per app until Capgo sees CI ship the app
once, or the user says CI/CD is already set up.

## When the sidebar shows it

`shouldShowCiCdNav` in `src/utils/cicdSetupState.ts`, rendered by
`GettingStartedNav.vue`:

1. Getting started is no longer shown for the app (done or dismissed).
2. The app already ships: `features.ota.succeeded_at`,
   `features.builder.succeeded_at`, or a completed setup checklist.
3. `apps.onboarding.cicd` has no detection and no `marked_done_at`.

At most three apps are listed, the most recently active first. There is no
dismiss button: the entry stays until CI ships once or the guide marks it set
up.

Visible tabs refresh only the three displayed CI/CD entries every 30 seconds.
When those entries connect, the next displayed apps are checked on the next
tick. Initial organization refreshes still cover all apps; store updates batch
changed rows and preserve newer reads and local writes.

## Stored state: `apps.onboarding.cicd`

| Field | Written by | Meaning |
| --- | --- | --- |
| `keys`, `key_created_at`, `selection` | `record_app_cicd_setup('key_created')` | Caller-owned API keys registered for setup (max 10) and the answers chosen |
| `marked_done_at` | `record_app_cicd_setup('marked_done')` | The user says CI/CD already ships this app |
| `ota_detected_at`, `builder_detected_at` | `record_app_cicd_deploy` (backend) | First bundle upload / build request from CI |
| `ota_detected_via`, `ota_ci_provider`, `builder_detected_via`, `builder_ci_provider` | `record_app_cicd_deploy` | Attribution of each product's first successful detection |
| `detected_via`, `ci_provider` | `record_app_cicd_deploy` | Source of the first detection across either product, preserved when the other product connects |

`record_app_cicd_setup` needs app read access and only tracks the caller's own
keys. Registration is a setup hint, not proof that a key was created by the
guide or that it was used in CI. App readers can also mark setup done
explicitly. Neither path grants access or affects release authorization.
`record_app_cicd_deploy` is `service_role` only.

## Detection

`POST /bundle/upsert` calls `recordCicdDeploy` only for the final
`storage_provider: r2` update, which the CLI sends after the zip and manifest
uploads finish, or after an external upload supplies its URL. Metadata
creation and intermediate TUS path updates do not count. Hosted uploads record
after `POST /bundle/upload/complete` finalizes the artifact and assigns its
channels. External bundle references (`POST /bundle`) and native build requests
(`POST /build/request`) record after their successful response.

The helper (`supabase/functions/_backend/utils/cicdDetection.ts`) records the
first detection when:

- the request carries `x-cli-ci` (sent by `@capgo/cli` when `ci-info` detects
  CI), or
- the request's API key is one of the guide keys.

Older CLI versions do not send `x-cli-ci`. Their CI runs are only detected
through a guide key, so those users can mark the step as set up from the guide.

## Generated GitHub workflow authentication

Generated GitHub workflows explicitly grant `GITHUB_TOKEN` only `contents: read`.
The release-head guard uses the persisted checkout credentials to read the remote
branch on private repositories. If you set `persist-credentials: false`, configure
separate read-only Git authentication for that guard before running it.
