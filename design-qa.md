# Design QA: app deletion feedback

Status: passed

## Inputs

- Source visual: `/Users/michaltremblay/.codex/generated_images/01a0e272-9a5a-7ec0-95ba-e43578940ed5/exec-ebf84fb3-c112-4bd9-97a2-ebf2da6043cb.png`
- Implementation: `http://127.0.0.1:4173/preview/app-delete-feedback` (temporary local harness rendering the production component with fake data)
- Reviewed at 1440×1000 and 390×844 in the Codex in-app browser.

## Results

| Severity | Result |
| --- | --- |
| P0 | None |
| P1 | None |
| P2 | None remaining |

The first pass placed the expanded details below the full reason list. It was moved directly beneath the selected reason to match the approved interaction. The compact card hierarchy, responsive stacking, selected states, optional detail chips, and separate permanent-confirmation screen now preserve the target design.

The deliberate differences reflect the final product decisions: a top-level reason is required, the feedback opt-out is nested under Other, and the left summary uses known app metadata rather than inferred onboarding history.

## Interaction checks

- Continue is disabled until one of the six reasons is selected.
- Every reason exposes its expected optional details inline.
- Other contains “I don't want to provide feedback”; choosing it hides the note field.
- Continue opens the permanent confirmation screen without presenting a step count.
- The destructive action stays disabled for an empty or incorrect confirmation and enables only for an exact, case-sensitive App ID.
- Back returns to the feedback screen without deleting anything.
- Mobile review showed no horizontal overflow (`scrollWidth === clientWidth`).
- No feature-specific console errors were produced. Existing router deprecation warnings and Turnstile errors from the earlier login page were unrelated to this flow.
