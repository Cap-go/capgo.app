CREATE SCHEMA IF NOT EXISTS seed_helpers;

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.seed_demo_customer_telemetry()') IS NOT NULL THEN
    ALTER FUNCTION public.seed_demo_customer_telemetry() SET SCHEMA seed_helpers;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_and_seed_demo_customer_data()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
SECURITY DEFINER
AS $_$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.orgs WHERE id = 'acde0000-0000-4000-8000-0000000000a1'::uuid) THEN
    PERFORM public.seed_demo_customer_account();
  END IF;
  PERFORM seed_helpers.seed_demo_customer_telemetry();
END;
$_$;

ALTER FUNCTION public.reset_and_seed_demo_customer_data() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reset_and_seed_demo_customer_data() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reset_and_seed_demo_customer_data() TO service_role;
