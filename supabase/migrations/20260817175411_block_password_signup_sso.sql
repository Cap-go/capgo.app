-- Block password/OAuth user creation when the email already belongs to an SSO
-- user or to an active SSO domain. Return the same client error GoTrue uses for
-- duplicate email signup so callers cannot tell SSO emails apart from existing
-- password accounts.
--
-- Runs once per auth.users insert (signup / admin create). Lookups are bounded:
-- unique (email) WHERE is_sso_user = false, btree on lower(email), unique domain
-- on public.sso_providers.

CREATE OR REPLACE FUNCTION public.is_sso_auth_provider(p_provider text, p_providers jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT
    COALESCE(p_provider, '') = 'sso'
    OR COALESCE(p_provider, '') LIKE 'sso:%'
    OR (
      jsonb_typeof(COALESCE(p_providers, '[]'::jsonb)) = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(p_providers, '[]'::jsonb)) AS elem
        WHERE jsonb_typeof(elem) = 'string'
          AND (
            (elem #>> '{}') = 'sso'
            OR (elem #>> '{}') LIKE 'sso:%'
          )
      )
    );
$$;

ALTER FUNCTION public.is_sso_auth_provider(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_sso_auth_provider(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_sso_auth_provider(text, jsonb) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.is_sso_auth_provider(text, jsonb) TO service_role;
GRANT ALL ON FUNCTION public.is_sso_auth_provider(text, jsonb) TO supabase_auth_admin;

CREATE OR REPLACE FUNCTION public.password_signup_blocked_for_email(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p_email IS NOT NULL
    AND btrim(p_email) <> ''
    AND (
      EXISTS (
        SELECT 1
        FROM auth.users AS au
        WHERE lower(au.email) = lower(btrim(p_email))
          AND au.is_sso_user IS TRUE
      )
      OR EXISTS (
        SELECT 1
        FROM public.sso_providers AS sp
        WHERE sp.domain = lower(split_part(btrim(p_email), '@', 2))
          AND sp.status = 'active'
      )
    );
$$;

COMMENT ON FUNCTION public.password_signup_blocked_for_email(text) IS
  'True when password signup must be refused for this email: an SSO auth user already exists, or the domain has an active SSO provider. Used by the before-user-created hook and auth.users insert trigger. Not granted to anon/authenticated so it cannot be used as an existence oracle.';

ALTER FUNCTION public.password_signup_blocked_for_email(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.password_signup_blocked_for_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.password_signup_blocked_for_email(text) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.password_signup_blocked_for_email(text) TO service_role;
GRANT ALL ON FUNCTION public.password_signup_blocked_for_email(text) TO supabase_auth_admin;

CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email text;
  v_provider text;
  v_providers jsonb;
BEGIN
  v_email := event->'user'->>'email';
  v_provider := event->'user'->'app_metadata'->>'provider';
  v_providers := event->'user'->'app_metadata'->'providers';

  IF COALESCE(event->'user'->>'is_sso_user', '') IN ('true', 't') THEN
    RETURN '{}'::jsonb;
  END IF;

  IF public.is_sso_auth_provider(v_provider, v_providers) THEN
    RETURN '{}'::jsonb;
  END IF;

  IF public.password_signup_blocked_for_email(v_email) THEN
    -- Exact GoTrue duplicate-email copy. Do not mention SSO.
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 422,
        'message', 'User already registered'
      )
    );
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

ALTER FUNCTION public.hook_before_user_created(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hook_before_user_created(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hook_before_user_created(jsonb) FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;

CREATE OR REPLACE FUNCTION public.prevent_password_signup_on_sso()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_sso_user IS TRUE THEN
    RETURN NEW;
  END IF;

  IF public.is_sso_auth_provider(
    NEW.raw_app_meta_data->>'provider',
    NEW.raw_app_meta_data->'providers'
  ) THEN
    RETURN NEW;
  END IF;

  IF public.password_signup_blocked_for_email(NEW.email) THEN
    RAISE EXCEPTION 'User already registered'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_password_signup_on_sso() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_password_signup_on_sso() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_password_signup_on_sso ON auth.users;
CREATE TRIGGER prevent_password_signup_on_sso
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_password_signup_on_sso();
