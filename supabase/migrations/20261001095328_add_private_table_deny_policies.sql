-- These tables are intentionally private. Backend connections, table owners,
-- and service_role bypass RLS; PostgREST callers must not access rows directly.
CREATE POLICY "Deny all direct access"
ON "public"."app_onboarding"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny all direct access"
ON "public"."app_stats_refresh_state"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny all direct access"
ON "public"."manifest_per_version"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny all direct access"
ON "public"."mcp_oauth_clients"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny all direct access"
ON "public"."mcp_oauth_requests"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny all direct access"
ON "public"."org_stats_refresh_state"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
