-- CLI trial-warning helpers: expose billing/credit status through
-- authorization-aware SECURITY DEFINER RPCs so app-scoped API keys (and other
-- callers that cannot SELECT orgs via RLS) can still read the flags.

-- Add app-scoped overloads for existing plan-status RPCs used by the CLI.
CREATE OR REPLACE FUNCTION "public"."is_paying_org"("orgid" "uuid", "appid" character varying)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT public.current_request_role() INTO caller_role;

  IF NOT public.is_internal_request_role(caller_role) THEN
    IF appid IS NOT NULL THEN
      IF NOT public.rbac_check_permission_request(
        public.rbac_perm_app_read(),
        orgid,
        appid,
        NULL::bigint
      ) THEN
        RETURN false;
      END IF;
    ELSIF NOT public.request_has_org_read_access(orgid) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN (
    SELECT EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE customer_id = (SELECT customer_id FROM public.orgs WHERE id = orgid)
        AND status = 'succeeded'
    )
  );
END;
$$;

ALTER FUNCTION public.is_paying_org(uuid, character varying) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_paying_org(uuid, character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_paying_org(uuid, character varying) TO anon;
GRANT ALL ON FUNCTION public.is_paying_org(uuid, character varying) TO authenticated;
GRANT ALL ON FUNCTION public.is_paying_org(uuid, character varying) TO service_role;

CREATE OR REPLACE FUNCTION "public"."is_paying_org"("orgid" "uuid")
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.is_paying_org(orgid, NULL::character varying);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."is_trial_org"("orgid" "uuid", "appid" character varying)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT public.current_request_role() INTO caller_role;

  IF NOT public.is_internal_request_role(caller_role) THEN
    IF appid IS NOT NULL THEN
      IF NOT public.rbac_check_permission_request(
        public.rbac_perm_app_read(),
        orgid,
        appid,
        NULL::bigint
      ) THEN
        RETURN 0;
      END IF;
    ELSIF NOT public.request_has_org_read_access(orgid) THEN
      RETURN 0;
    END IF;
  END IF;

  RETURN COALESCE(
    (
      SELECT GREATEST((trial_at::date - NOW()::date), 0)
      FROM public.stripe_info
      WHERE customer_id = (SELECT customer_id FROM public.orgs WHERE id = orgid)
    ),
    0
  );
END;
$$;

ALTER FUNCTION public.is_trial_org(uuid, character varying) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_trial_org(uuid, character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_trial_org(uuid, character varying) TO anon;
GRANT ALL ON FUNCTION public.is_trial_org(uuid, character varying) TO authenticated;
GRANT ALL ON FUNCTION public.is_trial_org(uuid, character varying) TO service_role;

CREATE OR REPLACE FUNCTION "public"."is_trial_org"("orgid" "uuid")
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.is_trial_org(orgid, NULL::character varying);
END;
$$;

-- New credit-flag RPC (orgs.has_usage_credits is not always readable via RLS).
CREATE OR REPLACE FUNCTION "public"."has_usage_credits_org"("orgid" "uuid", "appid" character varying)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT public.current_request_role() INTO caller_role;

  IF NOT public.is_internal_request_role(caller_role) THEN
    IF appid IS NOT NULL THEN
      IF NOT public.rbac_check_permission_request(
        public.rbac_perm_app_read(),
        orgid,
        appid,
        NULL::bigint
      ) THEN
        RETURN false;
      END IF;
    ELSIF NOT public.request_has_org_read_access(orgid) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN COALESCE(
    (
      SELECT o.has_usage_credits
      FROM public.orgs o
      WHERE o.id = orgid
    ),
    false
  );
END;
$$;

ALTER FUNCTION public.has_usage_credits_org(uuid, character varying) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_usage_credits_org(uuid, character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_usage_credits_org(uuid, character varying) TO anon;
GRANT ALL ON FUNCTION public.has_usage_credits_org(uuid, character varying) TO authenticated;
GRANT ALL ON FUNCTION public.has_usage_credits_org(uuid, character varying) TO service_role;

COMMENT ON FUNCTION public.has_usage_credits_org(uuid, character varying) IS
  'Returns orgs.has_usage_credits for callers with org read access, or app read access when appid is provided. Used by the CLI to skip trial upgrade warnings for credit-only orgs.';

CREATE OR REPLACE FUNCTION "public"."has_usage_credits_org"("orgid" "uuid")
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.has_usage_credits_org(orgid, NULL::character varying);
END;
$$;

ALTER FUNCTION public.has_usage_credits_org(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_usage_credits_org(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_usage_credits_org(uuid) TO anon;
GRANT ALL ON FUNCTION public.has_usage_credits_org(uuid) TO authenticated;
GRANT ALL ON FUNCTION public.has_usage_credits_org(uuid) TO service_role;

COMMENT ON FUNCTION public.has_usage_credits_org(uuid) IS
  'Org-scope overload of has_usage_credits_org(orgid, appid).';
