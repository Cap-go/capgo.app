# Onboarding Bento app events

Capgo emits two different app lifecycle events during pending onboarding. They
are deliberately not aliases.

| Event | Meaning | Earliest ordering point | Duplicate policy |
| --- | --- | --- | --- |
| `app:onboarding_ready` | A pending onboarding app is visible on the final Setup/todo-list screen and is ready for the user's first CLI command. | After the app and organization exist, before a CLI command can be copied or run. | Sent at most once per organization/app by the permanent notification claim `app:onboarding_ready:<app_id>`. Re-entering or resuming Setup is safe. |
| `app:created` | App creation completed for downstream completion analytics and existing consumers. For a pending onboarding app, this means the CLI or another terminal setup path cleared `need_onboarding`. | After `app:onboarding_ready` for pending onboarding apps; it may occur much later or never. | Existing behavior is unchanged. It must not be repurposed as the Setup reminder trigger. |

`app:onboarding_ready` is accepted only for an authenticated caller that can
read the requested app in the requested organization. The backend re-reads the
records and requires `apps.need_onboarding = true`; browser-supplied metadata is
not forwarded to Bento. Its payload contains:

- `onboarding_intent` and the intent-specific onboarding URLs;
- `org_id`, `org_name`, and `org_website`;
- `app_id`, `app_name`, and `existing_app`;
- `created_by_user_id` and `created_by_email` when stored on the app (otherwise
  those fields are `null`).

The Bento “Aha moment” workflow's first-app-ready branch must trigger on
`app:onboarding_ready`, not `app:created`. Keep its existing `first_app` and
`onboarding:first_app_ready:*` tag checks: the backend claim prevents repeated
event delivery, while the workflow tags protect against already-running or
historical workflow sessions.

Deployment order matters because Bento accepting an `app:onboarding_ready`
event consumes its permanent backend claim even if no workflow is listening.
Use this rollout sequence:

1. Temporarily make the workflow trigger accept either `app:created` or
   `app:onboarding_ready`.
2. Deploy the backend/frontend emitter.
3. Narrow the workflow trigger to `app:onboarding_ready` after the deployment
   is live.

The workflow's existing `first_app` tag guard prevents the later `app:created`
event from sending a second message during the overlap. Continue emitting
`app:created` after the rollout—only the reminder workflow moves to
`app:onboarding_ready`.
