-- updates_cache_purge_pending and updates_cache_purge_state are service-only
-- queue/state for /updates edge cache purges. Backend connections, table
-- owners, and service_role bypass RLS; PostgREST callers must not access rows.
--
-- 20261002000000_updates_cache_purge_deny_policies.sql already creates these
-- same policies; drop first so applying both migrations stays idempotent.
DROP POLICY IF EXISTS "Deny all direct access" ON "public"."updates_cache_purge_pending";
CREATE POLICY "Deny all direct access"
ON "public"."updates_cache_purge_pending"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

DROP POLICY IF EXISTS "Deny all direct access" ON "public"."updates_cache_purge_state";
CREATE POLICY "Deny all direct access"
ON "public"."updates_cache_purge_state"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
