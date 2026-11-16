-- Batch RBAC permission checks.
--
-- The console used to call rbac_check_permission once per permission and per
-- row (3 RPCs per channel row in the channel table, one per member and
-- permission in the "who can grant access" modal, ...). Each RPC is a full
-- round trip through the Capgo API. rbac_check_permissions evaluates many
-- checks in one call.
--
-- Execution model (scalability gate):
-- - Runs as an RPC from the console (authenticated) and from the backend
--   (service role / backend DB user). It is not used in RLS, views or triggers.
-- - Runs once per request. The array is capped at 500 entries, and each entry
--   runs exactly one existing single-check function, so the cost is bounded by
--   500 x the cost of rbac_check_permission, which only does indexed lookups.
--
-- Exact parity with the single checks, by construction:
-- - An entry without "user_id" and "apikey" runs
--   public.rbac_check_permission(permission_key, org_id, app_id, channel_id),
--   the auth.uid() based user check the console already calls.
-- - An entry with "user_id" or "apikey" runs
--   public.rbac_check_permission_direct(permission_key, user_id, org_id,
--   app_id, channel_id, apikey), the user / API-key principal check used by the
--   backend and by userHasPermission in the console.
-- - The function is SECURITY INVOKER: it adds no privilege of its own. The
--   caller must hold EXECUTE on the single-check function each entry uses, and
--   each of those keeps its own SECURITY DEFINER, empty search_path and
--   caller binding (rbac_caller_can_check_user_permission). EXECUTE is granted
--   to the same roles as rbac_check_permission (authenticated, service_role).
-- - A malformed scope value (non-UUID org_id or user_id, non-integer
--   channel_id) returns allowed = false for that entry instead of aborting the
--   whole batch. The single RPC raises a cast error there, which every caller
--   already maps to "denied".

CREATE OR REPLACE FUNCTION public.rbac_check_permissions(p_checks jsonb)
RETURNS TABLE (idx integer, key text, allowed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_max_checks constant integer := 500;
BEGIN
  IF p_checks IS NULL OR jsonb_typeof(p_checks) <> 'array' THEN
    RAISE EXCEPTION 'p_checks must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_checks) > v_max_checks THEN
    RAISE EXCEPTION 'p_checks accepts at most % entries', v_max_checks
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH input AS (
    SELECT
      (e.ord - 1)::integer AS check_idx,
      CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value ELSE '{}'::jsonb END AS item
    FROM jsonb_array_elements(p_checks) WITH ORDINALITY AS e(value, ord)
  ),
  raw AS (
    SELECT
      i.check_idx,
      i.item ->> 'key' AS check_key,
      i.item ->> 'permission_key' AS permission_key,
      NULLIF(i.item ->> 'org_id', '') AS org_text,
      NULLIF(i.item ->> 'app_id', '') AS app_id,
      NULLIF(i.item ->> 'channel_id', '') AS channel_text,
      NULLIF(i.item ->> 'user_id', '') AS user_text,
      i.item ->> 'apikey' AS apikey,
      (i.item ? 'user_id' OR i.item ? 'apikey') AS use_direct
    FROM input i
  ),
  parsed AS (
    SELECT
      r.check_idx,
      r.check_key,
      r.permission_key,
      r.app_id,
      r.apikey,
      r.use_direct,
      (r.org_text IS NULL OR r.org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        AND (r.user_text IS NULL OR r.user_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        AND (r.channel_text IS NULL OR r.channel_text ~ '^-?[0-9]{1,18}$') AS is_valid,
      r.org_text,
      r.user_text,
      r.channel_text
    FROM raw r
  )
  SELECT
    p.check_idx,
    p.check_key,
    CASE
      WHEN NOT p.is_valid THEN false
      WHEN p.use_direct THEN COALESCE(public.rbac_check_permission_direct(
        p.permission_key,
        p.user_text::uuid,
        p.org_text::uuid,
        p.app_id::character varying,
        p.channel_text::bigint,
        p.apikey
      ), false)
      ELSE COALESCE(public.rbac_check_permission(
        p.permission_key,
        p.org_text::uuid,
        p.app_id::character varying,
        p.channel_text::bigint
      ), false)
    END
  FROM parsed p
  ORDER BY p.check_idx;
END;
$$;

ALTER FUNCTION public.rbac_check_permissions(jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.rbac_check_permissions(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rbac_check_permissions(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.rbac_check_permissions(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_check_permissions(jsonb) TO service_role;

COMMENT ON FUNCTION public.rbac_check_permissions(jsonb) IS
  'Batch RBAC check. p_checks is a JSON array (max 500) of {key?, permission_key, org_id?, app_id?, channel_id?, user_id?, apikey?}. Entries without user_id/apikey run rbac_check_permission (auth.uid()); entries with either run rbac_check_permission_direct. SECURITY INVOKER: callers need EXECUTE on the delegate. Returns (idx 0-based, key, allowed) in input order.';
