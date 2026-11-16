-- Replace Supabase Vault with a plain settings table so the database runs on
-- any managed Postgres (no supabase_vault extension needed).
--
-- private.settings holds the runtime secrets and switches the SQL functions
-- below used to read from vault.decrypted_secrets. Values are plain text:
-- Vault's encryption never protected them from the postgres role (it can read
-- vault.decrypted_secrets), and that role is still the only reader here.
-- The private schema is not exposed through the Data API (config.toml
-- api.schemas) and the table is not in the read-replica publication.
--
-- Change a value with:
--   INSERT INTO private.settings (name, value) VALUES ('<NAME>', '<value>')
--   ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--
-- Existing Vault rows are copied over and left in place (unused); they go away
-- with the extension when the database moves off Supabase.

CREATE SCHEMA IF NOT EXISTS private;
ALTER SCHEMA private OWNER TO postgres;
REVOKE ALL ON SCHEMA private FROM public, anon, authenticated, service_role;

CREATE TABLE private.settings (
    name text PRIMARY KEY CHECK (name <> ''),
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE private.settings IS
'Runtime secrets and switches read by SECURITY DEFINER functions (replaces Supabase Vault). postgres only.';

ALTER TABLE private.settings OWNER TO postgres;
ALTER TABLE private.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct access"
ON private.settings
AS RESTRICTIVE
FOR ALL
TO public
USING (false)
WITH CHECK (false);
REVOKE ALL ON TABLE private.settings FROM public,
anon,
authenticated,
service_role;

-- Copy the current values when Vault is installed (Supabase). On plain
-- Postgres there is nothing to copy and the seed fills the table.
DO $$
BEGIN
  IF pg_catalog.to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    EXECUTE $copy$
      INSERT INTO private.settings (name, value)
      SELECT name, decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name IN (
        'apikey',
        'db_url',
        'admin_users',
        'CAPGO_MFA_EMAIL_OTP_ENFORCED_AT',
        'CAPGO_UPDATES_CACHE_PURGE_ENABLED',
        'CAPGO_DELTA_STORAGE_GC_ENABLED',
        'CAPGO_DELTA_FILES_COMPACT_ENABLED',
        'CAPGO_DELTA_SESSIONS_ENABLED',
        'CAPGO_PLUGIN_STATE_SYNC_ENABLED'
      )
        AND decrypted_secret IS NOT NULL
      ON CONFLICT (name) DO NOTHING
    $copy$;
  END IF;
END;
$$;

-- Same signatures, attributes and fallbacks as before; only the source changes.

CREATE OR REPLACE FUNCTION public.get_apikey()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = ''
AS $$
BEGIN
  RETURN (SELECT value FROM private.settings WHERE name = 'apikey');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_db_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = ''
AS $$
BEGIN
  RETURN (SELECT value FROM private.settings WHERE name = 'db_url');
END;
$$;

-- Now SECURITY DEFINER: as SECURITY INVOKER it could only read the table as
-- postgres. Its only caller is the SECURITY DEFINER trigger
-- enforce_email_otp_for_mfa; service_role keeps its existing grant.
CREATE OR REPLACE FUNCTION public.get_mfa_email_otp_enforced_at()
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_setting text;
BEGIN
  SELECT value
  INTO v_setting
  FROM private.settings
  WHERE name = 'CAPGO_MFA_EMAIL_OTP_ENFORCED_AT';

  IF v_setting IS NULL OR pg_catalog.btrim(v_setting) = '' THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_setting::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_mfa_email_otp_enforced_at() FROM public,
anon,
authenticated;
GRANT EXECUTE ON FUNCTION public.get_mfa_email_otp_enforced_at() TO service_role;

-- Platform admins come from the admin_users setting (JSON array of user ids),
-- which only the postgres role can change. There is still no API, UI or
-- database path for other roles to grant or revoke platform admin.
CREATE OR REPLACE FUNCTION public.is_platform_admin(userid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  admin_ids_jsonb jsonb;
  mfa_verified boolean;
BEGIN
  SELECT public.verify_mfa() INTO mfa_verified;
  IF NOT mfa_verified THEN
    RETURN false;
  END IF;

  SELECT value::jsonb
  INTO admin_ids_jsonb
  FROM private.settings
  WHERE name = 'admin_users';

  RETURN COALESCE(admin_ids_jsonb ? userid::text, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.updates_cache_purge_enabled()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_setting text;
BEGIN
  SELECT value
  INTO v_setting
  FROM private.settings
  WHERE name = 'CAPGO_UPDATES_CACHE_PURGE_ENABLED';

  RETURN pg_catalog.lower(pg_catalog.btrim(COALESCE(v_setting, ''))) IN ('true', 'on', '1');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.delta_storage_setting(
    p_name text, p_default boolean
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_setting text;
BEGIN
  SELECT pg_catalog.lower(pg_catalog.btrim(value))
  INTO v_setting
  FROM private.settings
  WHERE name = p_name;

  IF v_setting IN ('true', 'on', '1') THEN
    RETURN true;
  ELSIF v_setting IN ('false', 'off', '0') THEN
    RETURN false;
  END IF;
  RETURN p_default;
EXCEPTION WHEN OTHERS THEN
  RETURN p_default;
END;
$$;

CREATE OR REPLACE FUNCTION public.plugin_state_sync_enabled()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_setting text;
BEGIN
  SELECT value
  INTO v_setting
  FROM private.settings
  WHERE name = 'CAPGO_PLUGIN_STATE_SYNC_ENABLED';

  RETURN pg_catalog.lower(pg_catalog.btrim(COALESCE(v_setting, ''))) IN ('true', 'on', '1');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
