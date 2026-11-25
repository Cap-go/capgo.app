-- Auth moves to our self-hosted GoTrue, whose tables live in auth_cf.
--
-- Production (GoTrue already created its tables in auth_cf): copy accounts,
-- MFA factors, SSO providers and pending email tokens from auth, then point
-- the foreign keys and the two Capgo auth triggers at auth_cf. Sessions are
-- not copied: everyone signs in again.
-- Everywhere else (local dev, CI, self-hosting on Supabase Auth): each
-- auth_cf table is a plain view of the auth table with the same name.
-- In both cases every public function then reads auth_cf instead of auth.

-- Copies auth rows into auth_cf. p_replace first empties auth_cf (test data)
-- and copies everything. Without it (catch-up after the switch, run by hand:
-- SELECT public.copy_auth_to_auth_cf(false);) it only adds the accounts and
-- SSO providers created on hosted Auth after the first copy (its time is kept
-- in private.settings), with their own rows, so nothing removed on our GoTrue
-- meanwhile comes back.
CREATE OR REPLACE FUNCTION public.copy_auth_to_auth_cf(p_replace boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_table text;
  v_columns text;
  v_values text;
  v_filter text := '';
  v_new_users uuid[];
  v_new_providers uuid[];
  v_copied_at timestamptz;
BEGIN
  IF (SELECT relkind FROM pg_catalog.pg_class WHERE oid = to_regclass('auth_cf.users')) IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'auth_cf.users is not a GoTrue table';
  END IF;

  IF p_replace THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE confrelid = 'auth_cf.users'::regclass AND connamespace <> 'auth_cf'::regnamespace
    ) THEN
      RAISE EXCEPTION 'refusing to empty auth_cf: other schemas reference auth_cf.users';
    END IF;
    TRUNCATE auth_cf.users, auth_cf.sso_providers CASCADE;
    INSERT INTO private.settings (name, value) VALUES ('AUTH_CF_COPIED_AT', now()::text)
    ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = now();
  ELSE
    -- Only what hosted Auth created after the first copy; anything older and
    -- missing here was deleted here.
    SELECT value::timestamptz INTO v_copied_at FROM private.settings WHERE name = 'AUTH_CF_COPIED_AT';
    IF v_copied_at IS NULL THEN
      RAISE EXCEPTION 'no first copy recorded (AUTH_CF_COPIED_AT)';
    END IF;
    SELECT coalesce(array_agg(a.id), '{}') INTO v_new_users
    FROM auth.users AS a
    WHERE a.created_at > v_copied_at AND NOT EXISTS (SELECT 1 FROM auth_cf.users AS c WHERE c.id = a.id);
    SELECT coalesce(array_agg(a.id), '{}') INTO v_new_providers
    FROM auth.sso_providers AS a
    WHERE a.created_at > v_copied_at AND NOT EXISTS (SELECT 1 FROM auth_cf.sso_providers AS c WHERE c.id = a.id);
  END IF;

  -- Parents first. Generated columns are skipped; enums are cast by name
  -- because auth and auth_cf each have their own enum types.
  FOREACH v_table IN ARRAY ARRAY['sso_providers', 'sso_domains', 'saml_providers', 'users', 'identities', 'mfa_factors', 'one_time_tokens'] LOOP
    IF NOT p_replace THEN
      v_filter := CASE v_table
        WHEN 'users' THEN format(' WHERE s.id = ANY (%L::uuid[])', v_new_users)
        WHEN 'sso_providers' THEN format(' WHERE s.id = ANY (%L::uuid[])', v_new_providers)
        WHEN 'sso_domains' THEN format(' WHERE s.sso_provider_id = ANY (%L::uuid[])', v_new_providers)
        WHEN 'saml_providers' THEN format(' WHERE s.sso_provider_id = ANY (%L::uuid[])', v_new_providers)
        ELSE format(' WHERE s.user_id = ANY (%L::uuid[])', v_new_users)
      END;
    END IF;

    SELECT
      string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum),
      string_agg(CASE
        WHEN t.typnamespace = 'auth_cf'::regnamespace THEN format('s.%I::text::%s', a.attname, format_type(a.atttypid, a.atttypmod))
        ELSE format('s.%I', a.attname)
      END, ', ' ORDER BY a.attnum)
    INTO v_columns, v_values
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    WHERE a.attrelid = format('auth_cf.%I', v_table)::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attgenerated = ''
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS s
        WHERE s.attrelid = format('auth.%I', v_table)::regclass
          AND s.attname = a.attname
          AND s.attnum > 0
          AND NOT s.attisdropped
      );

    EXECUTE format('INSERT INTO auth_cf.%I (%s) SELECT %s FROM auth.%I AS s%s ON CONFLICT DO NOTHING', v_table, v_columns, v_values, v_table, v_filter);
  END LOOP;
END;
$$;

ALTER FUNCTION public.copy_auth_to_auth_cf(boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.copy_auth_to_auth_cf(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copy_auth_to_auth_cf(boolean) FROM anon, authenticated, service_role;

DO $$
DECLARE
  v_table text;
  v_fk record;
BEGIN
  IF to_regclass('auth_cf.users') IS NULL THEN
    FOREACH v_table IN ARRAY ARRAY['users', 'identities', 'mfa_factors', 'sessions', 'sso_providers', 'sso_domains', 'saml_providers', 'one_time_tokens'] LOOP
      IF to_regclass(format('auth.%I', v_table)) IS NOT NULL THEN
        EXECUTE format('CREATE VIEW auth_cf.%I AS SELECT * FROM auth.%I', v_table, v_table);
      END IF;
    END LOOP;
    RETURN;
  END IF;

  PERFORM public.copy_auth_to_auth_cf(true);

  FOR v_fk IN
    SELECT c.conrelid::regclass AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_catalog.pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND c.connamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_fk.tbl, v_fk.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', v_fk.tbl, v_fk.conname, replace(v_fk.def, 'REFERENCES auth.users(', 'REFERENCES auth_cf.users('));
  END LOOP;

  CREATE TRIGGER prevent_password_signup_on_sso
    BEFORE INSERT ON auth_cf.users
    FOR EACH ROW EXECUTE FUNCTION public.prevent_password_signup_on_sso();
  CREATE TRIGGER trg_enforce_email_otp_for_mfa
    BEFORE INSERT OR UPDATE ON auth_cf.mfa_factors
    FOR EACH ROW EXECUTE FUNCTION public.enforce_email_otp_for_mfa();
END;
$$;

-- Point every Capgo function at auth_cf (auth.users and "auth"."users" alike,
-- plus the information_schema check in password_signup_blocked_for_email).
-- auth.uid(), auth.jwt() and the other claim helpers are not tables and stay.
-- copy_auth_to_auth_cf reads auth on purpose.
DO $$
DECLARE
  v_pattern constant text := '(^|[^[:alnum:]_."])"?auth"?\.("?)(users|identities|mfa_factors|sessions|sso_providers|sso_domains|saml_providers|one_time_tokens)\M';
  v_fn oid;
BEGIN
  FOR v_fn IN
    SELECT p.oid
    FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS d WHERE d.objid = p.oid AND d.deptype = 'e')
      AND p.proname <> 'copy_auth_to_auth_cf'
      AND pg_get_functiondef(p.oid) ~ v_pattern
  LOOP
    EXECUTE replace(
      regexp_replace(pg_get_functiondef(v_fn), v_pattern, '\1auth_cf.\2\3', 'g'),
      'table_schema = ''auth''',
      'table_schema = ''auth_cf'''
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS d WHERE d.objid = p.oid AND d.deptype = 'e')
      AND p.proname <> 'copy_auth_to_auth_cf'
      AND pg_get_functiondef(p.oid) ~ v_pattern
  ) THEN
    RAISE EXCEPTION 'public functions still read auth tables';
  END IF;
END;
$$;
