-- Block direct PostgREST writes to orgs.customer_id unless the caller has
-- org.update_billing. Internal/service paths bypass via
-- is_internal_request_role.
--
-- Execution profile for guard_org_billing_columns (BEFORE UPDATE OF
-- customer_id):
-- - Frequency: at most once per row when customer_id actually changes (trigger
--   column list skips name/settings-only org updates). Console-scale billing
--   writes, not plugin hot path.
-- - Roles: authenticated and anon (capgkey) via PostgREST;
--   service_role/postgres bypass the RBAC gate through
--   is_internal_request_role(current_request_role()).
-- - Authorization path: one rbac_check_permission_request(org.update_billing,
--   org_id, NULL, NULL) per guarded update, which resolves auth.uid()/capgkey
--   once and walks org-scoped role_bindings.
-- - Cardinality: role_bindings per (principal, org) are typically single-digit;
--   permission inheritance stays bounded to that org scope (no app/channel
--   fan-out for this check).
-- - Indexes: role_bindings_principal_scope_idx (principal_type, principal_id,
--   scope_type, org_id, app_id, channel_id); role_bindings_scope_idx
--   (scope_type, org_id, app_id, channel_id); role_bindings_principal_org_idx
--   when present (principal_type, principal_id, org_id, expires_at).
-- - Worst case (authenticated org member with many bindings): Index Scan on
--   role_bindings_principal_scope_idx with org_id/scope_type filters; nested
--   permission-role lookups stay bounded to the caller's bindings. No
--   sequential scan over role_bindings in EXPLAIN (ANALYZE, BUFFERS) on local
--   seed data for org-scoped org.update_billing checks.

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

COMMENT ON FUNCTION "public"."guard_org_billing_columns"() IS
  'BEFORE UPDATE OF customer_id guard. Runs once per changed customer_id (console billing writes, not plugin /updates). '
  'User-context callers need org.update_billing via rbac_check_permission_request; service_role/postgres bypass. '
  'Org-scoped RBAC lookups use role_bindings_principal_scope_idx / role_bindings_scope_idx (Index Scan at seed scale).';

DROP TRIGGER IF EXISTS "guard_org_billing_columns" ON "public"."orgs";

CREATE TRIGGER "guard_org_billing_columns"
  BEFORE UPDATE OF "customer_id" ON "public"."orgs"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."guard_org_billing_columns"();
