create table public."console_auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "firstName" text, "lastName" text, "optForNewsletters" boolean, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "twoFactorEnabled" boolean, "userMetadata" jsonb, "appMetadata" jsonb, "migrationBlocked" boolean);

create table public."console_auth_session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references public."console_auth_user" ("id") on delete cascade, "mfaVerified" boolean, "impersonatedBy" text, "ssoProviderId" text);

create table public."console_auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references public."console_auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "providerProfile" jsonb, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table public."console_auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table public."console_auth_two_factor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references public."console_auth_user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

create table public."console_auth_sso_provider" ("id" text not null primary key, "issuer" text not null, "oidcConfig" text, "samlConfig" text, "userId" text not null references public."console_auth_user" ("id") on delete cascade, "providerId" text not null unique, "organizationId" text, "domain" text not null);

create table public."console_auth_rate_limit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "console_auth_session_userId_idx" on public."console_auth_session" ("userId");

create index "console_auth_account_userId_idx" on public."console_auth_account" ("userId");

create index "console_auth_verification_identifier_idx" on public."console_auth_verification" ("identifier");

create index "console_auth_two_factor_secret_idx" on public."console_auth_two_factor" ("secret");

create index "console_auth_two_factor_userId_idx" on public."console_auth_two_factor" ("userId");

ALTER TABLE public."console_auth_user" OWNER TO postgres;
ALTER TABLE public."console_auth_user" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_user" FROM PUBLIC, anon, authenticated;


ALTER TABLE public."console_auth_session" OWNER TO postgres;
ALTER TABLE public."console_auth_session" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_session" FROM PUBLIC, anon, authenticated;


ALTER TABLE public."console_auth_account" OWNER TO postgres;
ALTER TABLE public."console_auth_account" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_account" FROM PUBLIC, anon, authenticated;


ALTER TABLE public."console_auth_verification" OWNER TO postgres;
ALTER TABLE public."console_auth_verification" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_verification" FROM PUBLIC, anon, authenticated;


ALTER TABLE public."console_auth_two_factor" OWNER TO postgres;
ALTER TABLE public."console_auth_two_factor" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_two_factor" FROM PUBLIC, anon, authenticated;


ALTER TABLE public."console_auth_sso_provider" OWNER TO postgres;
ALTER TABLE public."console_auth_sso_provider" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_sso_provider" FROM PUBLIC, anon, authenticated;


ALTER TABLE public."console_auth_rate_limit" OWNER TO postgres;
ALTER TABLE public."console_auth_rate_limit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."console_auth_rate_limit" FROM PUBLIC, anon, authenticated;


CREATE POLICY "Deny direct access" ON public."console_auth_user" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct access" ON public."console_auth_session" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct access" ON public."console_auth_account" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct access" ON public."console_auth_verification" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct access" ON public."console_auth_two_factor" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct access" ON public."console_auth_sso_provider" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

CREATE POLICY "Deny direct access" ON public."console_auth_rate_limit" AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

-- Existing RLS callers use a scalar SELECT. The Better Auth lookup is one
-- primary-key lookup for auth.uid(), independent of protected-table row count.
CREATE OR REPLACE FUNCTION public.has_2fa_enabled(user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN (SELECT auth.jwt()->>'auth_provider') = 'better-auth'
    THEN COALESCE((SELECT u."twoFactorEnabled" FROM public.console_auth_user u WHERE u.id = user_id::text), false)
    ELSE COALESCE((SELECT u."twoFactorEnabled" FROM public.console_auth_user u WHERE u.id = user_id::text), false)
      OR EXISTS(SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = has_2fa_enabled.user_id AND f.status = 'verified')
  END;
$$;
ALTER FUNCTION public.has_2fa_enabled(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_2fa_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_2fa_enabled(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.has_2fa_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.has_2fa_enabled((SELECT auth.uid()));
$$;
ALTER FUNCTION public.has_2fa_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_2fa_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_2fa_enabled() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.verify_mfa() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN (SELECT auth.jwt()->>'auth_provider') = 'better-auth'
    THEN (SELECT COALESCE(auth.jwt()->>'aal', 'aal1')) = 'aal2'
      OR NOT COALESCE((SELECT u."twoFactorEnabled" FROM public.console_auth_user u WHERE u.id = (SELECT auth.uid())::text), true)
    ELSE (SELECT COALESCE(auth.jwt()->>'aal', 'aal1')) = 'aal2'
      OR NOT public.has_2fa_enabled((SELECT auth.uid()))
    END OR (SELECT public.is_active_platform_impersonation());
$$;
ALTER FUNCTION public.verify_mfa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.verify_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_mfa() TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.verify_mfa() IS 'Checks the signed provider claim against an indexed caller identity. Legacy CLI sessions retain their existing Supabase factor checks. Registered support impersonation is the only MFA exemption.';

-- A scalar subquery becomes an InitPlan, so the MFA lookup runs once per
-- statement rather than once per candidate row on unfiltered console queries.
ALTER POLICY "Prevent non 2FA access" ON public.apikeys USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.app_versions USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.apps USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.channel_devices USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.channels USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.org_users USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.orgs USING ((SELECT public.verify_mfa()));

-- Account removal already deletes auth.users. Preserve that single lifecycle
-- boundary during the transitional database bridge: one indexed delete per user.
CREATE FUNCTION public.delete_console_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.console_auth_user WHERE id = OLD.id::text;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.delete_console_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_console_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_console_identity() TO service_role;
CREATE TRIGGER delete_console_identity AFTER DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.delete_console_identity();
