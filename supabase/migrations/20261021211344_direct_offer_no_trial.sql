-- Paid-ads signups ("pay first") get no free trial.
--
-- Signups from paid ads send `offer = 'direct'` to /auth/register (or the Apple
-- flow), which stores it in server-controlled auth app metadata
-- (raw_app_meta_data). Users can edit raw_user_meta_data, so it is never read
-- here. When the org creator carries that flag, the default
-- stripe_info row is created with trial_at = NOW() (a zero-length trial) instead
-- of NOW() + 15 days. Only the literal value 'direct' has any effect; every
-- other value (or no value) keeps the standard 15-day trial.
--
-- The function body is otherwise identical to the definition in
-- 20260826103000_org_billing_column_guard.sql. The extra lookup is a single
-- primary-key read on auth.users per org insert.
CREATE OR REPLACE FUNCTION "public"."generate_org_user_stripe_info_on_org_create"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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

  IF NEW.customer_id IS NOT NULL THEN
    PERFORM set_config('capgo.org_creation_bootstrap_org_id', '', true);
    RETURN NEW;
  END IF;

  pending_customer_id := 'pending_' || NEW.id::text;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_info
    WHERE customer_id = pending_customer_id
  ) THEN
    UPDATE public.orgs
    SET customer_id = pending_customer_id
    WHERE id = NEW.id;

    PERFORM set_config('capgo.org_creation_bootstrap_org_id', '', true);
    RETURN NEW;
  END IF;

  SELECT stripe_id INTO solo_plan_stripe_id
  FROM public.plans
  WHERE name = 'Solo'
  LIMIT 1;

  IF solo_plan_stripe_id IS NULL THEN
    PERFORM set_config('capgo.org_creation_bootstrap_org_id', '', true);
    RAISE WARNING 'Solo plan not found, skipping sync stripe_info creation for org %', NEW.id;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM auth.users
    WHERE id = NEW.created_by
      AND raw_app_meta_data ->> 'offer' = 'direct'
  ) THEN
    -- Direct offer (paid ads): no trial, the user must subscribe first.
    trial_at_date := NOW();
  ELSE
    trial_at_date := NOW() + INTERVAL '15 days';
  END IF;

  INSERT INTO public.stripe_info (
    customer_id,
    product_id,
    trial_at,
    status,
    is_good_plan
  ) VALUES (
    pending_customer_id,
    solo_plan_stripe_id,
    trial_at_date,
    NULL,
    true
  );

  UPDATE public.orgs
  SET customer_id = pending_customer_id
  WHERE id = NEW.id;

  PERFORM set_config('capgo.org_creation_bootstrap_org_id', '', true);

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."generate_org_user_stripe_info_on_org_create"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."generate_org_user_stripe_info_on_org_create"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."generate_org_user_stripe_info_on_org_create"() TO "service_role";
