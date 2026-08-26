CREATE OR REPLACE FUNCTION "public"."guard_org_billing_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_request_role text := public.current_request_role();
BEGIN
  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    IF NOT public.rbac_check_permission_request(
      public.rbac_perm_org_update_billing(),
      NEW.id,
      NULL::character varying,
      NULL::bigint
    ) THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_UPDATE_BILLING'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."guard_org_billing_columns"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."guard_org_billing_columns"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."guard_org_billing_columns"() TO "service_role";

COMMENT ON FUNCTION "public"."guard_org_billing_columns"() IS 'Blocks user-context writes to org.customer_id unless the caller has org.update_billing. Internal/service paths remain unrestricted.';

DROP TRIGGER IF EXISTS "guard_org_billing_columns" ON "public"."orgs";

CREATE TRIGGER "guard_org_billing_columns"
  BEFORE UPDATE OF "customer_id" ON "public"."orgs"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."guard_org_billing_columns"();
