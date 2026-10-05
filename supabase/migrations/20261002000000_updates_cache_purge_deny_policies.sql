-- These tables are intentionally private. Backend connections, table owners,
-- and service_role bypass RLS; PostgREST callers must not access rows directly.
CREATE POLICY "Deny all direct access"
ON "public"."updates_cache_purge_pending"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny all direct access"
ON "public"."updates_cache_purge_state"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
