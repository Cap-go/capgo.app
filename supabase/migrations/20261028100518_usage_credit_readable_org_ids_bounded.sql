-- usage_credit_readable_org_ids() feeds the SELECT RLS of usage_credit_transactions,
-- usage_credit_grants, usage_credit_consumptions and usage_overage_events, so every
-- read of the usage_credit_ledger view evaluates it four times. It scanned every row
-- of public.orgs and ran rbac_check_permission_request() per org, which made the
-- Credits page ledger read take 4 to 9 seconds in production. It was also VOLATILE,
-- which stops the planner from inlining the ledger view CTEs and pushing the org_id
-- filter down to the indexed base tables.
--
-- rbac_check_permission_direct() can only grant an org-level permission through an
-- org-scope role binding (direct, or through a group of that org for users), so
-- the orgs that pass are a subset of the principal's org-scope bindings.
-- rbac_org_ids_for_permission() starts from exactly those candidate orgs and runs
-- the same rbac_check_permission_direct() check on each one, for both JWT users
-- and API keys, matching what rbac_check_permission_request() resolves.

CREATE OR REPLACE FUNCTION public.usage_credit_readable_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.rbac_org_ids_for_permission(public.rbac_perm_org_read_billing())
$$;

COMMENT ON FUNCTION public.usage_credit_readable_org_ids() IS
  'Returns org IDs whose usage-credit rows are readable by the current user session or Capgo API key through RBAC billing-read permission. Candidates come from the principal''s org-scope bindings, so RLS computes a bounded set once per statement.';
