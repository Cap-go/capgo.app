-- cloud_terminal_enabled is billing-gated; only service_role may set it.
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
      OR NEW.cloud_terminal_enabled IS DISTINCT FROM false
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

  IF NEW.cloud_terminal_enabled IS DISTINCT FROM OLD.cloud_terminal_enabled THEN
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
'has_usage_credits, auto_top_up_*, cloud_terminal_enabled). User/capgkey roles '
'cannot write them; service_role/postgres bypass via is_internal_request_role.';

DROP TRIGGER IF EXISTS "guard_org_billing_columns" ON "public"."orgs";

CREATE TRIGGER "guard_org_billing_columns"
BEFORE UPDATE OF
"customer_id",
"has_usage_credits",
"auto_top_up_enabled",
"auto_top_up_threshold",
"auto_top_up_monthly_limit",
"auto_top_up_last_attempt_at",
"cloud_terminal_enabled"
ON "public"."orgs"
FOR EACH ROW
EXECUTE FUNCTION "public"."guard_org_billing_columns"();