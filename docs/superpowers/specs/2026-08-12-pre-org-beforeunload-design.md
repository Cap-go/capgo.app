# Pre-organization unload warning

## Goal

Warn fresh-account users before they close or reload Capgo while initial organization and app creation is incomplete.

## Design

- Register a `beforeunload` handler when `AppOnboardingFlow` mounts with `preOrg` enabled.
- The handler calls `preventDefault()` and sets `returnValue` so supported browsers may show their native confirmation dialog.
- Keep the handler active after validation or creation failures.
- Remove it immediately after both the organization and app have been created successfully.
- Always remove it when the component unmounts to prevent leaked or duplicate listeners.
- Never register it for existing-organization app creation.

## Scope

The production implementation stays inside `AppOnboardingFlow.vue` and changes no more than 20 lines. No custom dialog, analytics event, router guard, or admin-dashboard change is included.

## Verification

Add focused coverage for pre-organization registration, successful removal, existing-organization exclusion, and unmount cleanup. Run frontend lint, frontend typecheck, the relevant unit tests, the full unit suite, and a production build before opening the PR.
