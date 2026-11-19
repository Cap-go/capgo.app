# Direct-offer advertising attribution

For a new visitor arriving with `offer=direct`, the website captures the first
UTM source, medium, campaign, content (creative), and term. The opaque OpenAI
`oppref` travels unchanged through the first-party attribution cookie, signup
links and `/auth/register` into user metadata. An optional invalid reference is
ignored, so tracking cannot prevent registration.

The registration trigger forwards the saved reference on `registration_completed`.
The Stripe first-payment handler loads the organization creator's saved reference
on the primary database and forwards it on `subscription_created`. It still
requires a paid invoice and keeps the existing per-user/per-org deduplication IDs.
A signup, incomplete checkout, or unpaid trial is not a paid conversion.

The UTM fields also accompany checkout and billing analytics events, enabling
creative-level funnel reports. Raw `oppref` is only used for OpenAI matching, not
added to general analytics event tags or PostHog person properties.

OpenAI reference: https://developers.openai.com/ads/conversions-api

## Release and verification

1. Deploy the backend change before the companion website change so new metadata
   is accepted as soon as the website starts sending it. No database migration.
2. Use a fresh test visitor with synthetic UTM values and a real ad click when
   verifying live attribution. Confirm the same creative and click reference
   reach auth metadata after registration; do not publish that reference.
3. Check that the direct-offer account gets the choose-plan step, without a free
   trial. New accounts default to monthly billing; an existing annual customer's
   interval and an explicit annual selection remain available.
4. Validate a CAPI payload with `validate_only: true` before relying on live event
   reporting. This validates the request; it does not create a conversion.
5. After a real customer payment, reconcile the paid invoice, stored `paid_at`,
   the single CAPI subscription event, and Ads Manager's eventual attribution.
   Local emulator coverage does not prove a live attributed sale.

Past visitors with missing click references cannot be reconstructed by this
change. Do not replay historical signups as purchases. Compare a new cohort only
after both deployments; budget and campaign decisions remain operational.

## Trial emails

Trial suppression and paid-offer lifecycle copy already shipped in PR #4154.
See [the rollout record](bento/trial-email-rollout.md). The shared legacy Stripe
trial event remains intact for normal onboarding. The existing suppression tests
cover direct-offer and paid users, including delayed workflow subscribers.
