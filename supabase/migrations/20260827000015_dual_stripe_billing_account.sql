-- Dual Stripe account scaffolding: persist billing account per org, nullable US plan catalog columns.
-- EE remains the default; existing rows are backfilled to EE. US product/price IDs stay empty until configured.

ALTER TABLE public.stripe_info
  ADD COLUMN IF NOT EXISTS billing_account text NOT NULL DEFAULT 'ee',
  ADD CONSTRAINT stripe_info_billing_account_check
    CHECK (billing_account IN ('ee', 'us'));

UPDATE public.stripe_info
SET billing_account = 'ee'
WHERE billing_account IS DISTINCT FROM 'ee';

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS stripe_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_m_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_y_id_us character varying,
  ADD COLUMN IF NOT EXISTS credit_id_us text;

ALTER TABLE public.processed_stripe_events
  ADD COLUMN IF NOT EXISTS billing_account text NOT NULL DEFAULT 'ee',
  ADD CONSTRAINT processed_stripe_events_billing_account_check
    CHECK (billing_account IN ('ee', 'us'));

UPDATE public.processed_stripe_events
SET billing_account = 'ee'
WHERE billing_account IS DISTINCT FROM 'ee';

ALTER TABLE public.processed_stripe_events
  DROP CONSTRAINT IF EXISTS processed_stripe_events_pkey;

ALTER TABLE public.processed_stripe_events
  ADD PRIMARY KEY (billing_account, event_id);

CREATE OR REPLACE FUNCTION public.generate_org_user_stripe_info_on_org_create()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  solo_plan_stripe_id varchar;
  pending_customer_id varchar;
  trial_at_date timestamptz;
  org_super_admin_role_id uuid;
BEGIN
  PERFORM set_config('capgo.org_creation_bootstrap_org_id', NEW.id::text, true);

  INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
  VALUES (NEW.created_by, NEW.id, public.rbac_role_org_super_admin(), false);

  SELECT id INTO org_super_admin_role_id
  FROM public.roles
  WHERE name = public.rbac_role_org_super_admin()
    AND scope_type = public.rbac_scope_org()
  LIMIT 1;

  IF org_super_admin_role_id IS NOT NULL THEN
    INSERT INTO public.role_bindings (
      principal_type, principal_id, role_id, scope_type, org_id,
      granted_by, granted_at, reason, is_direct
    ) VALUES (
      public.rbac_principal_user(), NEW.created_by, org_super_admin_role_id, public.rbac_scope_org(), NEW.id,
      NEW.created_by, now(), 'Organization creator', true
    ) ON CONFLICT DO NOTHING;
  END IF;

  PERFORM set_config('capgo.org_creation_bootstrap_org_id', '', true);

  IF NEW.customer_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT stripe_id INTO solo_plan_stripe_id
  FROM public.plans
  WHERE name = 'Solo'
  LIMIT 1;

  IF solo_plan_stripe_id IS NULL THEN
    RAISE WARNING 'Solo plan not found, skipping sync stripe_info creation for org %', NEW.id;
    RETURN NEW;
  END IF;

  pending_customer_id := 'pending_' || NEW.id::text;
  trial_at_date := NOW() + INTERVAL '15 days';

  INSERT INTO public.stripe_info (
    customer_id,
    product_id,
    trial_at,
    status,
    is_good_plan,
    billing_account
  ) VALUES (
    pending_customer_id,
    solo_plan_stripe_id,
    trial_at_date,
    NULL,
    true,
    'ee'
  );

  UPDATE public.orgs
  SET customer_id = pending_customer_id
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.generate_org_user_stripe_info_on_org_create() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_org_user_stripe_info_on_org_create() FROM PUBLIC;
GRANT ALL ON FUNCTION public.generate_org_user_stripe_info_on_org_create() TO service_role;
