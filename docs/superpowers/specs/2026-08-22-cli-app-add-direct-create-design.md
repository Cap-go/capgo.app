# CLI App Add Direct Create Design

## Problem

`npx @capgo/cli@latest app add <app-id>` performs `GET /app/<app-id>` before creating the app. The existing-app endpoint requires `app.read`, but a not-yet-created app cannot resolve an app-scoped permission. The backend therefore returns an authorization error instead of the `404` that the CLI treats as "available," and the CLI never reaches `POST /app`.

The frontend does not use this preflight. It submits `POST /app` and lets the create endpoint validate the organization permission and app ID uniqueness.

## Scope

Change only the CLI app-add path. Do not revert PR #2906, change the backend `GET /app/:id` endpoint, or change the shared `checkAppExists` helper used by commands that operate on existing apps.

## Design

The CLI app-add flow will:

1. Resolve the API key and app ID.
2. Validate the app ID locally, including the reserved `io.ionic.starter` ID.
3. Resolve the selected organization and require `org.create_app`.
4. Upload an icon on a best-effort basis.
5. Send `POST /app` directly.
6. Let the create endpoint return the authoritative collision, validation, and permission response.

The `ensureAppDoesNotExist` preflight and its `checkAppExists` import will be removed from `cli/src/app/add.ts`. The reserved-ID check will move into local option validation so removing the preflight does not weaken that guard.

## Error Handling

The existing `POST /app` response handling remains authoritative. In particular, duplicate app IDs produce the backend's `409 app_id_already_exists` error. Other validation and authorization errors remain surfaced through the current CLI formatting path.

The CLI must not reinterpret `401` from `GET /app/:id` as "not found": doing so would hide genuine access failures for existing-app commands.

## Regression Coverage

Extend the focused CLI app-creation test to enforce these source-level contracts:

- `cli/src/app/add.ts` does not import or call `checkAppExists`.
- `cli/src/app/add.ts` does not define or call `ensureAppDoesNotExist`.
- App creation still uses `POST`.
- The reserved `io.ionic.starter` guard remains present after the preflight is removed.

Run the focused test first and observe it fail on the current preflight. After the implementation, run CLI lint, typecheck, build, the focused test, and the complete CLI test suite required by repository guidance.

## Non-Goals

- Removing `GET /app/:id` from the backend.
- Removing `checkAppExists` from existing-app commands.
- Redesigning API error payloads.
- Reverting unrelated CLI HTTP, analytics, or admin work from PR #2906.
