-- Drop Supabase Vault now that private.settings replaced it
-- (20261113125918_replace_vault_with_private_settings.sql).
--
-- DROP EXTENSION deletes every Vault secret, so it only runs when each one
-- has the same value in private.settings. Otherwise Vault stays and the
-- migration warns, so a secret that was never copied is not lost.
-- No-op where Vault isn't installed (plain Postgres).

DO $$
DECLARE
  v_unmatched text[];
BEGIN
  IF pg_catalog.to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $q$
    SELECT pg_catalog.array_agg(COALESCE(v.name, '<unnamed>') ORDER BY v.name)
    FROM vault.decrypted_secrets AS v
    LEFT JOIN private.settings AS s ON s.name = v.name
    WHERE s.name IS NULL OR s.value IS DISTINCT FROM v.decrypted_secret
  $q$ INTO v_unmatched;

  IF v_unmatched IS NOT NULL THEN
    RAISE WARNING 'supabase_vault kept: these secrets differ from private.settings: %',
      pg_catalog.array_to_string(v_unmatched, ', ');
    RETURN;
  END IF;

  DROP EXTENSION IF EXISTS supabase_vault;
END;
$$;
