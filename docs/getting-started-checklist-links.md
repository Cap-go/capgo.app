# Getting started checklist links

To view an app's existing setup checklist, including completed or dismissed
setup, open:

```text
https://console.capgo.app/app/APP_ID/getting-started?showChecklist=1
```

Replace `APP_ID` with the URL-encoded app ID. Only the single query value
`showChecklist=1` enables this mode. Missing, empty, repeated, `0`, `false`, and
other values keep the normal automatic redirect for completed or dismissed setup.

This mode uses the app's persisted OTA or Builder checklist, selected path and
platform, and actual task statuses. It also works during a pre-organization setup
handoff. It does not reset checklist evidence, clear dismissal, create an app, or
restart the user's onboarding run. The existing authentication, app permissions,
owning organization selection, and unavailable-app handling still apply.

The checklist keeps its existing refresh and task controls. Opening the link does
not mark pending tasks complete. Leaving through its normal dashboard buttons
still works. Links without this opt-in retain their existing behavior.
