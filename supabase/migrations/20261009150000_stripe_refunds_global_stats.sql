-- Stripe refunds: one row per Stripe refund, written by the charge.refunded
-- webhook. The daily global stats revenue shard sums them per UTC day.

CREATE TABLE IF NOT EXISTS public.stripe_refunds (
  id character varying PRIMARY KEY,
  charge_id character varying NOT NULL,
  customer_id character varying,
  amount bigint NOT NULL,
  currency character varying NOT NULL,
  status character varying NOT NULL,
  reason character varying,
  refunded_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.stripe_refunds OWNER TO postgres;

COMMENT ON TABLE public.stripe_refunds IS 'Stripe refunds synced from the charge.refunded webhook, used for daily refund stats.';
COMMENT ON COLUMN public.stripe_refunds.id IS 'Stripe refund id (re_...).';
COMMENT ON COLUMN public.stripe_refunds.amount IS 'Refunded amount in the smallest currency unit (cents for USD).';
COMMENT ON COLUMN public.stripe_refunds.refunded_at IS 'Stripe refund creation time.';

CREATE INDEX IF NOT EXISTS stripe_refunds_refunded_at_idx ON public.stripe_refunds USING btree (refunded_at);
CREATE INDEX IF NOT EXISTS stripe_refunds_charge_id_idx ON public.stripe_refunds USING btree (charge_id);

ALTER TABLE public.stripe_refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all access" ON public.stripe_refunds USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.stripe_refunds FROM PUBLIC;
REVOKE ALL ON TABLE public.stripe_refunds FROM anon;
REVOKE ALL ON TABLE public.stripe_refunds FROM authenticated;
GRANT ALL ON TABLE public.stripe_refunds TO service_role;

ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS refunds_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunds_amount double precision NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.refunds_count IS 'Number of Stripe refunds created on the snapshot UTC day (failed and canceled refunds excluded).';
COMMENT ON COLUMN public.global_stats.refunds_amount IS 'Total USD amount refunded on the snapshot UTC day, in dollars (failed and canceled refunds excluded).';
