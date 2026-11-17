-- Console billing settings and a durable outbox; no new queue or cron.
CREATE TABLE public.invoice_email_preferences (
    org_id uuid PRIMARY KEY REFERENCES public.orgs (id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    recipients text[] NOT NULL DEFAULT '{}',
    CONSTRAINT invoice_email_recipient_count CHECK (
        cardinality(recipients) <= 5
    ),
    CONSTRAINT invoice_email_recipient_values CHECK (
        array_position(recipients, null) IS null
        AND array_to_string(recipients, ',') !~ E'[\\r\\n]'
    )
);

CREATE TABLE public.invoice_email_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
    billing_account text NOT NULL CHECK (billing_account IN ('ee', 'us')),
    customer_id text NOT NULL,
    invoice_id text NOT NULL,
    recipients text[] NOT NULL CHECK (cardinality(recipients) <= 5),
    accepted_recipients text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (billing_account, invoice_id)
);
CREATE INDEX invoice_email_deliveries_org_idx
ON public.invoice_email_deliveries (org_id);

ALTER TABLE public.invoice_email_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_email_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_email_preferences,
public.invoice_email_deliveries FROM public,
anon,
authenticated;
GRANT SELECT,
INSERT,
UPDATE,
DELETE ON public.invoice_email_preferences,
public.invoice_email_deliveries TO service_role;
COMMENT ON TABLE public.invoice_email_deliveries IS
'Paid invoice email decisions, deduplicated across Stripe event types.
Acceptance is not inbox delivery. Empty recipients records an opted-out invoice or missing mailbox.';
