-- SSO providers are only written by /private/sso/* (service role / direct
-- Postgres), which enforce the Enterprise plan, domain validation, the
-- Supabase Auth provider lifecycle and the auth.users.is_sso_user sync.
-- Direct PostgREST writes bypassed all of that: any org admin (every user owns
-- a personal org) could reserve any email domain with a pending row, and
-- client-side deletes silently left rows behind. Reads stay as they are.

DROP POLICY IF EXISTS "allow_org_admins_insert_sso_providers" ON "public"."sso_providers";
DROP POLICY IF EXISTS "allow_org_admins_update_sso_providers" ON "public"."sso_providers";
DROP POLICY IF EXISTS "allow_org_super_admins_delete_sso_providers" ON "public"."sso_providers";

CREATE POLICY "Deny client insert on sso_providers"
ON "public"."sso_providers"
AS RESTRICTIVE
FOR INSERT
TO "anon", "authenticated"
WITH CHECK (false);

CREATE POLICY "Deny client update on sso_providers"
ON "public"."sso_providers"
AS RESTRICTIVE
FOR UPDATE
TO "anon", "authenticated"
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny client delete on sso_providers"
ON "public"."sso_providers"
AS RESTRICTIVE
FOR DELETE
TO "anon", "authenticated"
USING (false);
