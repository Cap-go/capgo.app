-- Extend the orgs billing column guard beyond customer_id.
--
-- The orgs UPDATE RLS policy only requires org.update_settings, so every
-- billing-sensitive column must be protected by this trigger. Auto top-up
-- settings are saved by the backend (service_role) after an
-- org.update_billing check, and has_usage_credits is maintained by the
-- usage_credit_grants sync trigger / refresh cron. User and capgkey roles
-- (authenticated, anon) must never write these columns directly.
--
-- Execution profile for guard_org_billing_columns (BEFORE INSERT, and
-- BEFORE UPDATE OF customer_id, has_usage_credits, auto_top_up_*):
-- - Frequency: once per org row when one of the guarded columns is in the
--   UPDATE SET list, or once per inserted org row. Console-scale, not a
--   plugin hot path.
-- - Roles: authenticated and anon (capgkey) via PostgREST are denied for
--   any value change. service_role/postgres bypass via
--   is_internal_request_role().
-- - has_usage_credits: a non-internal change is only accepted when the new
--   value equals the grant-derived state (the sync trigger can run under a
--   user request role). That check is a single EXISTS bounded by
--   idx_usage_credit_grants_org_expires (org_id, expires_at), and only runs
--   when the value actually changes.
-- - Cardinality: single-row trigger; no table scans.

CREATE OR REPLACE FUNCTION "public"."guard_org_billing_columns"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_request_role text := public.current_request_role();
  v_bootstrap_org_id text := COALESCE(
    pg_catalog.current_setting('capgo.org_creation_bootstrap_org_id', true),
    ''
  );
  v_expected_has_usage_credits boolean;
BEGIN
  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.customer_id IS NOT NULL THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_CUSTOMER_ID'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.auto_top_up_enabled IS DISTINCT FROM false
      OR NEW.auto_top_up_threshold IS DISTINCT FROM 10::numeric
      OR NEW.auto_top_up_monthly_limit IS DISTINCT FROM 0::numeric
      OR NEW.auto_top_up_last_attempt_at IS NOT NULL
      OR NEW.has_usage_credits IS DISTINCT FROM false
    THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
    AND NOT (
      v_bootstrap_org_id <> ''
      AND v_bootstrap_org_id = NEW.id::text
    )
  THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_CUSTOMER_ID'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.auto_top_up_enabled IS DISTINCT FROM OLD.auto_top_up_enabled
    OR NEW.auto_top_up_threshold IS DISTINCT FROM OLD.auto_top_up_threshold
    OR NEW.auto_top_up_monthly_limit
    IS DISTINCT FROM OLD.auto_top_up_monthly_limit
    OR NEW.auto_top_up_last_attempt_at
    IS DISTINCT FROM OLD.auto_top_up_last_attempt_at
  THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.has_usage_credits IS DISTINCT FROM OLD.has_usage_credits THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.usage_credit_grants AS g
      WHERE g.org_id = NEW.id
        AND g.expires_at >= pg_catalog.now()
        AND g.credits_consumed < g.credits_total
    ) INTO v_expected_has_usage_credits;

    IF NEW.has_usage_credits IS DISTINCT FROM v_expected_has_usage_credits THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."guard_org_billing_columns"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."guard_org_billing_columns"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."guard_org_billing_columns"() TO "service_role";

COMMENT ON FUNCTION "public"."guard_org_billing_columns"() IS
'BEFORE INSERT/UPDATE guard for org billing columns (customer_id, '
'has_usage_credits, auto_top_up_*). User/capgkey roles cannot write them; '
'service_role/postgres bypass via is_internal_request_role. Org-create '
'bootstrap may set pending customer_id while '
'capgo.org_creation_bootstrap_org_id matches the row id. has_usage_credits '
'may only change to the usage_credit_grants-derived value.';

DROP TRIGGER IF EXISTS "guard_org_billing_columns" ON "public"."orgs";

CREATE TRIGGER "guard_org_billing_columns"
BEFORE UPDATE OF
"customer_id",
"has_usage_credits",
"auto_top_up_enabled",
"auto_top_up_threshold",
"auto_top_up_monthly_limit",
"auto_top_up_last_attempt_at"
ON "public"."orgs"
FOR EACH ROW
EXECUTE FUNCTION "public"."guard_org_billing_columns"();
