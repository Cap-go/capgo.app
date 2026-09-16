# A/B development-environment response chart

## Approved product design

Add a horizontal bar chart to the existing admin A/B Tests page. Show unique people assigned to treatment C of `webnativeapp_development_environment`, the experiment that introduced onboarding analytics version 5.C. Control D does not receive the question and must not enter the denominator. Later analytics versions that retain treatment C remain in this experiment cohort; do not filter only by an event version label.

The chart contains five rows, in this order: AI assistant, Hosted AI builder, Other, I write code by hand, and Did not select yet. Display each row's count and percentage of the entire treatment cohort, alongside the total unique-person count. “AI assistant” includes Claude, Cursor, Codex, and other assistants; existing data cannot identify Claude alone. Use the current A/B dashboard card and horizontal-progress-bar styling, with responsive layout, dark-mode support, and accessible labels.

## Data and boundaries

Read `public.users.onboarding` through the existing authenticated platform-admin statistics endpoint and replica connection. Apply indexed JSONB containment on `onboarding -> 'abtests'` for the configured development-environment treatment branch, using `users_onboarding_abtests_gin_idx`. Read one record per user; multiple other experiment assignments must not duplicate a person. Do not include publish-intent treatment users unless they independently belong to development-environment treatment C.

Use the saved user `development_environment` answer. Recognized answers map directly to `ai_assistant`, `hosted_builder`, `other`, and `hand_coded`. Missing, skipped, or legacy unsupported answers enter the fifth bucket, whose accompanying note explains that it includes unavailable or skipped answers. Do not infer answers from unrelated organizations or silently relabel historical values as explicit answers.

Add a small, dedicated backend aggregator and frontend response parser. Return five stable buckets and a total; the parser rejects malformed counts, duplicate or missing buckets, and totals that do not match their sum. Calculate percentages to one decimal place, returning zero for an empty cohort.

## Loading and failure behavior

Use the existing admin store caching and force-refresh retry behavior. Load the new statistic with the other A/B dashboard data. An invalid or failed response must produce the existing dashboard error and retry control, not an apparently empty or zero-count chart. An empty valid cohort renders five zero rows and a clear empty-data message.

## Verification and scope

Cover backend bucket order, zero filling, invalid counts, configured treatment-only SQL parameters, replica use, and pool closure on success and failure. Cover frontend strict parsing, count totals, empty data, percentages, and rendered labels. Run project lint before validation, the relevant and full unit suites, typecheck, and production build. Exercise the admin page with controlled responses and capture the new chart at desktop and mobile sizes.

No schema migration, RLS change, experiment rollout change, onboarding behavior change, production write, or deployment is required. Open a non-draft PR against current main containing only this feature. Apply pr-ready: all applicable checks and review requirements must pass on an unchanged head and base at two fresh observations at least 300 seconds apart before reporting stable-green.
