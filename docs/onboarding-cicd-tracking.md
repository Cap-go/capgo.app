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

## Stored state: `apps.onboarding.cicd`

| Field | Written by | Meaning |
| --- | --- | --- |
| `keys`, `key_created_at`, `selection` | `record_app_cicd_setup('key_created')` | API keys the guide created (max 10) and the answers chosen |
| `marked_done_at` | `record_app_cicd_setup('marked_done')` | The user says CI/CD already ships this app |
| `ota_detected_at`, `builder_detected_at` | `record_app_cicd_deploy` (backend) | First bundle upload / build request from CI |
| `detected_via`, `ci_provider` | `record_app_cicd_deploy` | `ci` (CLI ran in CI, provider name) or `key` (a guide key was used) |

`record_app_cicd_setup` needs app read access and only tracks the caller's own
keys. `record_app_cicd_deploy` is `service_role` only.

## Detection

`POST /bundle/upsert`, `POST /bundle` and `POST /build/request` call
`recordCicdDeploy` (`supabase/functions/_backend/utils/cicdDetection.ts`) after a
successful response. It records the first detection when:

- the request carries `x-cli-ci` (sent by `@capgo/cli` when `ci-info` detects
  CI), or
- the request's API key is one of the guide keys.

Older CLI versions do not send `x-cli-ci`. Their CI runs are only detected
through a guide key, so those users can mark the step as set up from the guide.
