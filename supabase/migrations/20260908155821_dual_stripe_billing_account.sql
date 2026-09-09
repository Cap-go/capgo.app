-- Dual Stripe billing: EE (legacy) + US (new orgs). Existing rows stay on EE.

ALTER TABLE public.stripe_info
  ADD COLUMN IF NOT EXISTS billing_account text;

UPDATE public.stripe_info
SET billing_account = 'ee'
WHERE billing_account IS NULL;

ALTER TABLE public.stripe_info
  ALTER COLUMN billing_account SET DEFAULT 'ee',
  ALTER COLUMN billing_account SET NOT NULL;

ALTER TABLE public.stripe_info
  DROP CONSTRAINT IF EXISTS stripe_info_billing_account_check;

ALTER TABLE public.stripe_info
  ADD CONSTRAINT stripe_info_billing_account_check
  CHECK (billing_account IN ('ee', 'us'));

COMMENT ON COLUMN public.stripe_info.billing_account IS
  'Stripe account: ee (Capgo OÜ legacy) or us (CodepushGo LLC).';

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS stripe_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_m_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_y_id_us character varying,
  ADD COLUMN IF NOT EXISTS credit_id_us text;

COMMENT ON COLUMN public.plans.stripe_id_us IS
  'Stripe product id on the US Stripe account.';
COMMENT ON COLUMN public.plans.price_m_id_us IS
  'Monthly Stripe price id on the US Stripe account.';
COMMENT ON COLUMN public.plans.price_y_id_us IS
  'Yearly Stripe price id on the US Stripe account.';
COMMENT ON COLUMN public.plans.credit_id_us IS
  'Stripe product id for credit top-ups on the US Stripe account.';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt1FTF7XJxyMR',
  price_m_id_us = 'price_1UDRGPLr632EP5z4ufTRBBzf',
  price_y_id_us = 'price_1UDRGULr632EP5z4OcZr5xpe',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Solo';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt2cnktX7IDVV',
  price_m_id_us = 'price_1UDRGQLr632EP5z4YI3A5cPV',
  price_y_id_us = 'price_1UDRGSLr632EP5z45R9qxkU8',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Maker';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt2xM7OyLzhqV',
  price_m_id_us = 'price_1UDRGSLr632EP5z4n0Npf7P1',
  price_y_id_us = 'price_1UDRGSLr632EP5z4jYu6vC42',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Team';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt2pia049SqpU',
  price_m_id_us = 'price_1UDRGaLr632EP5z4D02F4rLu',
  price_y_id_us = 'price_1UDRGcLr632EP5z4IxDyZuUK',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Enterprise';

-- product_id references EE plans.stripe_id or US plans.stripe_id_us.
ALTER TABLE public.stripe_info
  DROP CONSTRAINT IF EXISTS stripe_info_product_id_fkey;

CREATE OR REPLACE FUNCTION public.validate_stripe_info_product_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.billing_account = 'us' THEN
    PERFORM pg_advisory_xact_lock(hashtext('us:' || NEW.product_id));
    IF NOT EXISTS (
      SELECT 1
      FROM public.plans
      WHERE public.plans.stripe_id_us = NEW.product_id
    ) THEN
      RAISE EXCEPTION
        'stripe_info.product_id % is not a known US plan product id',
        NEW.product_id;
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('ee:' || NEW.product_id));
    IF NOT EXISTS (
      SELECT 1
      FROM public.plans
      WHERE public.plans.stripe_id = NEW.product_id
    ) THEN
      RAISE EXCEPTION
        'stripe_info.product_id % is not a known EE plan product id',
        NEW.product_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.validate_stripe_info_product_id() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.validate_stripe_info_product_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_stripe_info_product_id() TO service_role;

DROP TRIGGER IF EXISTS validate_stripe_info_product_id ON public.stripe_info;

CREATE TRIGGER validate_stripe_info_product_id
  BEFORE INSERT OR UPDATE OF product_id, billing_account ON public.stripe_info
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_stripe_info_product_id();

CREATE OR REPLACE FUNCTION public.prevent_orphan_stripe_info_plan_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtext('ee:' || OLD.stripe_id));
    IF OLD.stripe_id_us IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('us:' || OLD.stripe_id_us));
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE public.stripe_info.billing_account = 'ee'
        AND public.stripe_info.product_id = OLD.stripe_id
    ) THEN
      RAISE EXCEPTION
        'Cannot delete plan: stripe_info rows reference plans.stripe_id %',
        OLD.stripe_id;
    END IF;

    IF OLD.stripe_id_us IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE public.stripe_info.billing_account = 'us'
        AND public.stripe_info.product_id = OLD.stripe_id_us
    ) THEN
      RAISE EXCEPTION
        'Cannot delete plan: stripe_info rows reference plans.stripe_id_us %',
        OLD.stripe_id_us;
    END IF;

    RETURN OLD;
  END IF;

  IF OLD.stripe_id IS DISTINCT FROM NEW.stripe_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('ee:' || OLD.stripe_id));
  END IF;

  IF OLD.stripe_id IS DISTINCT FROM NEW.stripe_id AND EXISTS (
    SELECT 1
    FROM public.stripe_info
    WHERE public.stripe_info.billing_account = 'ee'
      AND public.stripe_info.product_id = OLD.stripe_id
  ) THEN
    RAISE EXCEPTION
      'Cannot change plans.stripe_id %: referenced by stripe_info (ee)',
      OLD.stripe_id;
  END IF;

  IF OLD.stripe_id_us IS DISTINCT FROM NEW.stripe_id_us AND OLD.stripe_id_us IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('us:' || OLD.stripe_id_us));
  END IF;

  IF OLD.stripe_id_us IS DISTINCT FROM NEW.stripe_id_us
    AND OLD.stripe_id_us IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE public.stripe_info.billing_account = 'us'
        AND public.stripe_info.product_id = OLD.stripe_id_us
    ) THEN
    RAISE EXCEPTION
      'Cannot change plans.stripe_id_us %: referenced by stripe_info (us)',
      OLD.stripe_id_us;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_orphan_stripe_info_plan_ids() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.prevent_orphan_stripe_info_plan_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prevent_orphan_stripe_info_plan_ids()
  TO service_role;

DROP TRIGGER IF EXISTS prevent_orphan_stripe_info_plan_ids ON public.plans;

CREATE TRIGGER prevent_orphan_stripe_info_plan_ids
  BEFORE UPDATE OF stripe_id, stripe_id_us OR DELETE ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_orphan_stripe_info_plan_ids();

-- apps channel_device_count / manifest_bundle_count bumps are bookkeeping for any
-- actor. Stale capgkey headers in the same SQL transaction must not turn recount
-- work into audit noise (see supabase/tests/40_test_audit_log_apikey.sql).
CREATE OR REPLACE FUNCTION public.audit_log_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_record jsonb;
  v_new_record jsonb;
  v_changed_fields text[];
  v_org_id uuid;
  v_record_id text;
  v_user_id uuid;
  v_key text;
  v_api_key_text text;
  v_api_key public.apikeys%ROWTYPE;
  v_actor_type text := 'system';
  v_actor_user_id uuid;
  v_actor_user_email text;
  v_actor_apikey_id bigint;
  v_actor_apikey_name text;
  v_stats_refresh_fields constant text[] := ARRAY['stats_refresh_requested_at', 'stats_updated_at', 'updated_at'];
  v_background_counter_fields constant text[] := ARRAY['channel_device_count', 'manifest_bundle_count', 'updated_at'];
  v_onboarding_progress_fields constant text[] := ARRAY['onboarding', 'updated_at'];
  v_fat_app_version_fields constant text[] := ARRAY['manifest', 'native_packages'];
BEGIN
  SELECT auth.uid() INTO v_actor_user_id;

  IF v_actor_user_id IS NOT NULL THEN
    v_actor_type := 'user';
  ELSE
    SELECT public.get_apikey_header() INTO v_api_key_text;

    IF v_api_key_text IS NOT NULL THEN
      SELECT *
      INTO v_api_key
      FROM public.find_apikey_by_value(v_api_key_text)
      LIMIT 1;

      IF v_api_key.id IS NOT NULL
        AND NOT public.is_apikey_expired(v_api_key.expires_at)
        AND (
          public.is_allowed_capgkey(v_api_key_text, '{upload}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{write}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{all}'::text[])
        ) THEN
        v_actor_type := 'apikey';
        v_actor_user_id := v_api_key.user_id;
        v_actor_apikey_id := v_api_key.id;
        v_actor_apikey_name := v_api_key.name;
      END IF;
    END IF;
  END IF;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT users.email
    INTO v_actor_user_email
    FROM public.users AS users
    WHERE users.id = v_actor_user_id;
  END IF;

  v_user_id := v_actor_user_id;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'app_versions' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);
    IF (
      v_old_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) IS NOT DISTINCT FROM (
      v_new_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old_record := NULL;
    v_new_record := pg_catalog.to_jsonb(NEW);
  ELSE
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);

    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_new_record)
    LOOP
      IF v_old_record->v_key IS DISTINCT FROM v_new_record->v_key THEN
        v_changed_fields := pg_catalog.array_append(v_changed_fields, v_key);
      END IF;
    END LOOP;

    IF v_changed_fields IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name IS DISTINCT FROM 'updated_at'
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = ANY(ARRAY['apps', 'orgs'])
      AND v_changed_fields && ARRAY['stats_refresh_requested_at', 'stats_updated_at']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_stats_refresh_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['channel_device_count', 'manifest_bundle_count']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_background_counter_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['onboarding']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_onboarding_progress_fields)
      ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'app_versions' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record - v_fat_app_version_fields;
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record - v_fat_app_version_fields;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := OLD.id;
        v_record_id := OLD.id::text;
      WHEN 'apps' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.app_id::text;
      WHEN 'channels' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'app_versions' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'org_users' THEN
        v_org_id := OLD.org_id;
        v_record_id := OLD.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  ELSE
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := NEW.id;
        v_record_id := NEW.id::text;
      WHEN 'apps' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.app_id::text;
      WHEN 'channels' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'app_versions' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'org_users' THEN
        v_org_id := NEW.org_id;
        v_record_id := NEW.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  END IF;

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      table_name,
      record_id,
      operation,
      user_id,
      org_id,
      old_record,
      new_record,
      changed_fields,
      actor_type,
      actor_user_id,
      actor_user_email,
      actor_apikey_id,
      actor_apikey_name
    ) VALUES (
      TG_TABLE_NAME,
      v_record_id,
      TG_OP,
      v_user_id,
      v_org_id,
      v_old_record,
      v_new_record,
      v_changed_fields,
      v_actor_type,
      v_actor_user_id,
      v_actor_user_email,
      v_actor_apikey_id,
      v_actor_apikey_name
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.audit_log_trigger() OWNER TO postgres;
