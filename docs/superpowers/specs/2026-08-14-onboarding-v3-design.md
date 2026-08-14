# Frontend Onboarding v3 Design

**Date:** 2026-08-14  
**Status:** Approved for implementation planning

## Summary

Replace the first-time unified frontend onboarding v2 with v3 for every user. V3 keeps the existing four-step flow and changes the organization and setup steps:

- Add the existing organization-details website import to the organization form.
- Create the organization and app before showing any invitation UI.
- Show the existing full organization invitation experience to Maker, Team, and Enterprise selections while keeping the progress indicator on Step 3.
- Send Solo selections directly to Step 4.
- Show the existing **Invite a technical teammate** option on Step 4 for every plan.
- Report the unified first-time flow as onboarding analytics version 3.

The design reuses existing UI and backend behavior. It introduces no database migration, onboarding-completion marker, account-date cohort, or refresh recovery.

## Goals

1. Let a user populate organization name, website, and logo from a company URL without duplicating the existing import service.
2. Give Maker, Team, and Enterprise users the current organization invitation experience without designing another invitation page.
3. Let any plan invite a technical administrator from the CLI setup screen, supporting a non-technical owner handing setup to a technical teammate.
4. Keep organization and app creation behavior consistent: both records exist before invitation is offered.
5. Preserve the older additional-organization experience when its invitation UI is extracted.
6. Measure the revised first-time funnel independently as onboarding v3.

## Non-goals

- Do not add or change database columns, tables, migrations, buckets, or user metadata.
- Do not store pre-organization onboarding state in Supabase.
- Do not add an `onboarding_incomplete` marker or any equivalent marker.
- Do not force a user back to invitations after refresh, closing the tab, or signing in again.
- Do not add a delayed or confirmed Skip dialog.
- Do not build multi-email entry or per-invite role selection.
- Do not redesign the existing invitation panel or invitation modal.
- Do not gate v3 by account creation date or a remote feature flag.

## Versioning and rollout

The unified first-time `/onboarding/app` flow becomes v3 for all users immediately after deployment. There is no `created_at` cutoff.

- Change unified onboarding progress analytics from version 2 to version 3.
- Keep historical v2 events unchanged.
- Keep older additional-organization and legacy setup flows on their existing analytics identity.
- Pass analytics context into extracted shared invitation components so a caller identifies its own flow and version.
- Do not rename unchanged translation keys solely because their internal key contains `v2`.

## User flow

### Steps 1 and 2

The goal and app-details steps remain unchanged.

### Step 3: organization details

The organization card uses this order:

1. Organization heading and helper text.
2. Organization name input.
3. Collapsed **Import organization details from website** control.
4. Mandatory active-user tier selection.
5. Back and **Create organization and app** actions.

The import control sits directly below the organization name and above the size question. The default form does not permanently show a website field, a manual logo uploader, or a separate logo column.

Clicking the import control reveals an inline URL input and Import action, following the existing app-import interaction. It calls the existing `private/website_preview` endpoint. A successful response:

- Retains the normalized website for organization creation.
- Fills the organization name while leaving it editable.
- Retains the returned logo and shows a compact imported-logo success preview.

The user may ignore or close the import control and enter the organization name manually.

### Record creation

Clicking **Create organization and app** performs the existing organization and app creation operations. The website is included in the organization request only when import succeeded.

The flow must not show invitations or Step 4 until both the organization and app exist. After creation, set the new organization as current. If an imported logo is available, reuse the corrected organization-logo upload behavior from GitHub PR #3052; do not implement another upload path.

The chosen plan controls only the next UI state:

| Selected tier | Next state after organization and app creation |
| --- | --- |
| Solo / up to 2K | Step 4 CLI setup |
| Maker / up to 10K | Existing invitation panel within Step 3 |
| Team / up to 100K | Existing invitation panel within Step 3 |
| Enterprise / 1M+ | Existing invitation panel within Step 3 |

### Step 3: organization invitations

Extract the current invitation section from `src/pages/onboarding/organization.vue` into a shared component. The extraction preserves the existing layout, copy, organization summary, invited-user list, invitation modal, and optional continuation behavior.

The shared component owns:

- Displaying the active organization summary.
- Opening the existing `InviteTeammateModal` for the correct organization.
- Tracking successfully sent invitations for its existing success state and list.
- Rendering the invitation and continuation actions.

The parent owns what continuation does. The component emits a continuation event and accepts caller-specific continuation copy and analytics context.

For unified v3, the continuation action reads **Continue** because the app already exists. It advances to Step 4 whether or not an invitation was sent. There is no skip-confirmation dialog. The progress indicator remains on Step 3 throughout the invitation state; invitations do not become a fifth top-level step.

The existing additional-organization route adopts the shared component while retaining its current continuation behavior and copy.

### Step 4: CLI setup

Extract the existing **Invite a technical teammate** option from `StepsApp.vue` into a reusable card and render it on the unified v3 CLI setup screen for every plan.

The card:

- Uses the existing technical variant of `InviteTeammateModal`.
- Retains the existing `org_admin` role for both new and existing invitees.
- Leaves the user on Step 4 after a successful invitation.
- Remains available so another technical teammate can be invited.

Place the card below the CLI command and above the AI-help card so it appears beside the technical setup task it can delegate.

## Component boundaries

### Shared organization invitation panel

Create a focused component for the existing organization invitation section. It receives the organization identity, continuation label/loading state, and analytics context. It emits `continue` and invitation-success information. It may coordinate the existing modal and local sent-invitation display, but it does not create apps or navigate.

Consumers:

- `src/pages/onboarding/organization.vue`
- `src/components/dashboard/AppOnboardingFlow.vue`

### Shared technical-teammate card

Create a focused component from the existing `StepsApp.vue` technical-invite block. It owns the existing copy and opens the technical invitation modal. It does not advance onboarding.

Consumers:

- `src/components/dashboard/StepsApp.vue`
- `src/components/dashboard/AppOnboardingFlow.vue`

### Unified flow orchestrator

`AppOnboardingFlow.vue` remains responsible for form state, website import state, record creation, plan-based branching, Step 3 substate, Step 4 navigation, and v3 progress analytics.

## Data and state

- Website import data remains frontend state until organization creation.
- The normalized website is sent through the existing organization API field.
- The imported logo uses the existing preview and organization-logo upload mechanisms.
- The selected plan is already represented by the current user-count stop and `estimatedMau` value.
- The organization and app are created before plan-based branching.
- Sent-invitation display state is local to the shared invitation panel.
- No new durable onboarding state is introduced.

## Error handling

### Website import

- Invalid URL: show the existing invalid-website error and keep the form usable.
- Import request failure: show the existing website-import error without clearing a manually entered organization name.
- Import success: allow the imported organization name to be edited before creation.

### Organization and app creation

- Organization failure: show the existing organization-creation error and remain on Step 3.
- App failure: do not show invitations or Step 4; retain the existing error and partial-creation handling rather than adding new persistence in this feature.
- Organization refresh/current-selection failure: preserve existing error behavior and do not render invitations against an unresolved organization.

### Logo import

- Reuse the corrected upload behavior from GitHub PR #3052.
- A failed logo fetch or upload must not imply that organization or app creation failed.
- Show the existing error feedback and continue without blocking the plan-appropriate next state.

### Invitations

- Keep the existing modal validation, CAPTCHA, API errors, and success behavior.
- A failed invitation leaves the invitation panel or Step 4 usable for retry.
- Continue from the organization invitation panel remains available without a successful invitation.

## Analytics

Set unified onboarding progress analytics to version 3. Retain the existing four visual steps and associate the invitation panel with the organization step.

Add or preserve events that identify:

- Organization website import opened, submitted, succeeded, and failed.
- Organization invitation panel viewed.
- Organization invitation modal opened and invitation succeeded.
- Organization invitation panel continued, including the number of successful invitations in the panel session.
- Technical-teammate invitation opened and succeeded from Step 4.

Every event from unified v3 includes onboarding version 3, flow `pre_org`, the appropriate step, and the onboarding attempt identifier when available. Extracted components receive analytics context rather than hard-coding v3, preserving older callers' current identity.

Analytics errors must never interrupt onboarding.

## Accessibility and responsive behavior

- The website-import toggle is a real button with expanded state communicated to assistive technology.
- The revealed URL input has an associated label and preserves keyboard order between organization name and size.
- Existing radio-group semantics for organization size remain unchanged.
- Extracted invitation actions retain their current focus, disabled, and loading behavior.
- The organization form, invitation panel, and technical-invite card remain usable at the existing mobile breakpoints.

## Testing

### Unit and integration coverage

- Verify unified progress events report onboarding version 3.
- Verify the website-import control starts collapsed and uses the existing preview endpoint.
- Verify import failure leaves manual organization entry usable.
- Verify import success fills an editable name and includes the normalized website in organization creation.
- Verify Solo creates both records and enters Step 4 without the full invitation panel.
- Verify Maker, Team, and Enterprise create both records before rendering the invitation panel.
- Verify continuing with zero invitations advances to Step 4.
- Verify invitation success updates the existing success state and still permits continuation.
- Verify the technical-teammate card appears on Step 4 for all four plans, uses `org_admin`, and does not advance or leave Step 4 after success.
- Verify the existing additional-organization route keeps its behavior after adopting the extracted panel.
- Preserve or update existing onboarding Vitest coverage affected by the extraction and v3 version change.

### Browser coverage

Add one Playwright happy path for a Maker selection:

1. Complete the organization form.
2. Create the organization and app.
3. Confirm that the existing invitation panel appears while Step 3 remains active.
4. Continue without inviting.
5. Confirm that Step 4 renders the CLI command and technical-teammate option.

Use focused coverage for website import success/failure without relying on an uncontrolled external website.

## Acceptance criteria

1. Unified first-time onboarding reports version 3 for every user, with no account-date gate.
2. Organization website import is collapsed below organization name and above mandatory size selection.
3. Successful import reuses the existing endpoint, normalized website field, and corrected logo-upload behavior.
4. Organization and app exist before any full invitation panel is shown.
5. Solo bypasses the full invitation panel.
6. Maker, Team, and Enterprise see the extracted existing invitation panel within Step 3.
7. The full invitation panel has no new confirmation dialog and can be continued without an invitation.
8. Step 4 shows **Invite a technical teammate** for every plan using the existing `org_admin` invitation behavior.
9. Existing additional-organization onboarding retains its current invitation behavior.
10. No schema, durable onboarding marker, forced resume, or refresh-recovery mechanism is added.
