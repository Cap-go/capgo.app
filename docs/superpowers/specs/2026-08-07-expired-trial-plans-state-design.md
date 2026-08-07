# Expired Trial State on the Plans Page

## Problem

The organization plans page currently treats every inaccessible, non-paying organization as a failed plan. This produces two misleading signals for an organization whose trial simply expired:

- A red banner says that the plan failed and asks the user to verify card details, even when the organization never entered a card or bought a plan.
- A plan card can receive the blue current-plan outline because `currentPlan` falls back to a plan such as Solo, even though the organization never subscribed to it.

The page also places several banner-like elements before the plan cards. Adding another expired-trial alert would increase noise instead of clarifying the state.

## Goals

- Clearly identify an expired trial without presenting it as an error.
- Never imply that an unpaid organization owns a plan.
- Use the same never-paid versus previously-paid distinction as the dashboard payment-required experience.
- Reduce the number of messages competing with the plan-selection task.
- Preserve all existing behavior for previously subscribed organizations, including ended subscriptions.

## Billing State Model

The plans page should resolve a display state from the organization entitlement data and billing history. The in-progress dashboard expired-trial work introduces `src/services/paymentRequired.ts`; the plans page should reuse or extend that shared logic rather than reproduce its query. `stripe_info.paid_at` distinguishes organizations that never paid from organizations that previously subscribed.

The plans page only needs to distinguish the expired-trial case from all existing billing cases:

1. **Active trial**: the organization is not paying and has trial days remaining.
2. **Expired trial**: the organization is inactive and `paid_at` is `null`, including a missing `stripe_info` relation.
3. **All existing billing states**: when `paid_at` contains a timestamp, preserve the current plans-page behavior without further classification or presentation changes.
4. **Active paid or credits-only**: retain the existing applicable plan or credits presentation.

An unresolved billing-history request is a loading state, not an expired trial. The page must not briefly render expired-trial copy while `paid_at` is still unknown.

The state resolver should be shared rather than duplicating conditional logic between the dashboard and plans page.

## Plans Page Presentation

### Expired trial

Replace the normal pricing introduction with state-aware header copy:

- Title: **Your free trial has ended**
- Description: **Choose a plan to continue using Capgo.**

Do not render an additional expired-trial banner. Use the normal page typography and neutral text colors rather than red or amber error styling.

All plan cards must be neutral:

- No current-plan outline.
- No selected state.
- No recommendation badge or recommendation styling.
- Each enabled action identifies the choice, for example **Choose Solo** or **Choose Maker**.

The plan grid is the primary next action. Move secondary choices below it:

1. Credits/pay-as-you-go alternative.
2. Expert support promotion.

The global organization status may say **Trial expired**, but the plans page must not repeat that status in a separate banner.

### Previously subscribed organizations

Do not change their copy, banners, colors, plan-card behavior, or billing-state classification in this work. This explicitly includes ended and canceled subscriptions.

## Plan Card Rules

An expired trial must not show a current plan. In expired-trial state, suppress current-plan, selected, and recommendation styling even if `currentPlan`, `bestPlan`, or a fallback plan resolves to Solo. Existing plan-card behavior outside the expired-trial state remains unchanged.

## Data Flow and Failure Handling

1. Load the current organization as today.
2. Resolve its billing history through the shared payment-required service.
3. Keep the header in its normal neutral pricing state while billing history is unresolved.
4. Ignore stale billing-history responses when the current organization changes.
5. Render the expired-trial header only for a resolved never-paid organization; otherwise preserve the existing presentation.

If the billing-history request fails, preserve the existing presentation and log the failure. Do not infer an expired trial from a failed lookup.

## Accessibility and Localization

- State differences must be conveyed in text, not by color alone.
- New copy must use translation keys in `messages/en.json`; do not use inline fallback strings.
- The heading remains the page's primary heading so screen-reader users encounter the organization state before the plan choices.
- Buttons must have plan-specific accessible text.

## Testing

Add unit coverage for the shared resolver and component coverage for the plans-page presentation:

- Never-paid organization with an expired trial gets expired-trial header copy.
- A missing `stripe_info` relation is treated as never paid.
- Previously paid and canceled organizations retain their current presentation.
- Other previously paid inactive organizations retain their current presentation.
- Unresolved or failed billing lookup never flashes expired-trial copy.
- Expired-trial cards have no selected, current, or recommended styling.
- Active paid plan-card behavior remains unchanged.
- Credits-only behavior remains intact.
- Switching organizations cannot apply stale billing history to the new organization.

## Out of Scope

- Changing Stripe subscription lifecycle behavior.
- Changing plan prices or plan recommendation behavior outside the expired-trial state.
- Redesigning the global dashboard payment-required overlay beyond sharing its billing-state resolver.
- Changing ended, canceled, or previously paid subscription states in any way.
