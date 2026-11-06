# Legacy Stripe trial event

The existing, independently signature-verified EE and US Stripe webhook routes
forward `customer.created` to Bento as `org:legacy_stripe_trial_started`.
The recipient is exactly the Stripe customer's email, trimmed and lowercased.
Capgo provisions that customer with the organization's management email, which
can differ from the owner or other members. This event does not fan out.
`customer.updated` and other event types do not send it.
This contract deliberately includes every signed `customer.created` on both
accounts, including US customers without org metadata. Metadata supplies context,
not product/cohort eligibility; the shared US account's other-product filters on
separate billing side effects do not apply to this event.

Event details contain `customer_id`, `stripe_event_id`, the verified
`billing_account` (`ee` or `us`), and `created_at` from the original Stripe event.
`org_id` is included from the linked organization or Stripe customer metadata
when available. Forwarding works before organization/customer provisioning has
finished; unlinked customer profiles do not perform live Stripe lookups that
could default to the wrong account. Linked profiles still synchronize billing
data after verifying the stored account matches the webhook account.

A missing/blank customer email or disabled Bento configuration is explicitly
logged as a skip. There is no fallback recipient. When configured, Bento must
accept the event; transport errors, unsuccessful HTTP responses, invalid JSON,
or rejected batch results return HTTP 503 so Stripe can retry.

Duplicate Stripe deliveries can send the event again. The existing processed
Stripe event ledger is specific to revenue metrics, not Bento delivery. There
is no new delivery ledger or exactly-once enrollment guarantee, and no claim
that a Bento details key deduplicates workflow starts.

This event is an additive compatibility path. It does not replace Bento's native
Stripe trigger. Switching the Trial flow root from native Stripe CustomerCreated
to `org:legacy_stripe_trial_started` is a separate later step. This change does
not edit that flow, Stripe integrations/settings, templates, delays, paid checks,
or running sessions, and does not require new-emails-v2.
