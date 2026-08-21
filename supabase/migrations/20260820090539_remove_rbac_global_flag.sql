-- RBAC is always on. Drop the unused global feature flag and vault secret.
DROP FUNCTION IF EXISTS public.is_rbac_enabled_globally();

DELETE FROM vault.secrets
WHERE name = 'CAPGO_RBAC_ENABLED';
