-- Block user-context writes to orgs.customer_id. Only service_role/postgres
-- (is_internal_request_role) and the org-create bootstrap path may set it.
--
-- Execution profile for guard_org_billing_columns (BEFORE INSERT OR UPDATE OF
-- customer_id):
-- - Frequency: once per org row when customer_id is supplied on INSERT or
--   changes on UPDATE. Console-scale, not plugin hot path.
-- - Roles: authenticated and anon (capgkey) via PostgREST are always denied
--   unless org-create bootstrap GUC matches the row during AFTER INSERT setup.
--   service_role/postgres bypass via is_internal_request_role().
-- - Cardinality: single-row trigger; no table scans.

CREATE OR REPLACE FUNCTION "public"."guard_org_billing_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_request_role text := public.current_request_role();
  v_bootstrap_org_id text := pg_catalog.current_setting('capgo.org_creation_bootstrap_org_id', true);
BEGIN
  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.customer_id IS DISTINCT FROM OLD.customer_id
    AND v_bootstrap_org_id <> ''
    AND v_bootstrap_org_id = NEW.id::text
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_CUSTOMER_ID'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_CUSTOMER_ID'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."guard_org_billing_columns"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."guard_org_billing_columns"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."guard_org_billing_columns"() TO "service_role";

COMMENT ON FUNCTION "public"."guard_org_billing_columns"() IS
  'BEFORE INSERT/UPDATE OF customer_id guard. User/capgkey roles cannot write customer_id; '
  'service_role/postgres bypass via is_internal_request_role. Org-create bootstrap may set '
  'pending customer_id while capgo.org_creation_bootstrap_org_id matches the row id.';

DROP TRIGGER IF EXISTS "guard_org_billing_columns" ON "public"."orgs";
DROP TRIGGER IF EXISTS "guard_org_billing_columns_insert" ON "public"."orgs";

CREATE TRIGGER "guard_org_billing_columns_insert"
  BEFORE INSERT ON "public"."orgs"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."guard_org_billing_columns"();

CREATE TRIGGER "guard_org_billing_columns"
  BEFORE UPDATE OF "customer_id" ON "public"."orgs"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."guard_org_billing_columns"();

-- Keep bootstrap GUC active through pending customer_id assignment so the guard
-- allows generate_org_user_stripe_info_on_org_create to finish for user inserts
-- that omit customer_id (legacy/direct PostgREST path).
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

  SELECT stripe_id INTO solo_plan_stripe_id
  FROM public.plans
  WHERE name = 'Solo'
  LIMIT 1;

  IF solo_plan_stripe_id IS NULL THEN
    PERFORM set_config('capgo.org_creation_bootstrap_org_id', '', true);
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
