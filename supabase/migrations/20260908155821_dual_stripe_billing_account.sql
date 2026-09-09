-- Dual Stripe billing: EE (legacy) + US (new orgs). Existing rows stay on EE.

ALTER TABLE public.stripe_info
  ADD COLUMN IF NOT EXISTS billing_account text;

UPDATE public.stripe_info
SET billing_account = 'ee'
WHERE billing_account IS NULL;

ALTER TABLE public.stripe_info
  ALTER COLUMN billing_account SET DEFAULT 'ee',
  ALTER COLUMN billing_account SET NOT NULL;

ALTER TABLE public.stripe_info
  DROP CONSTRAINT IF EXISTS stripe_info_billing_account_check;

ALTER TABLE public.stripe_info
  ADD CONSTRAINT stripe_info_billing_account_check
  CHECK (billing_account IN ('ee', 'us'));

COMMENT ON COLUMN public.stripe_info.billing_account IS
  'Stripe account: ee (Capgo OÜ legacy) or us (CodepushGo LLC).';

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS stripe_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_m_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_y_id_us character varying,
  ADD COLUMN IF NOT EXISTS credit_id_us text;

COMMENT ON COLUMN public.plans.stripe_id_us IS
  'Stripe product id on the US Stripe account.';
COMMENT ON COLUMN public.plans.price_m_id_us IS
  'Monthly Stripe price id on the US Stripe account.';
COMMENT ON COLUMN public.plans.price_y_id_us IS
  'Yearly Stripe price id on the US Stripe account.';
COMMENT ON COLUMN public.plans.credit_id_us IS
  'Stripe product id for credit top-ups on the US Stripe account.';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt1FTF7XJxyMR',
  price_m_id_us = 'price_1UDRGPLr632EP5z4ufTRBBzf',
  price_y_id_us = 'price_1UDRGULr632EP5z4OcZr5xpe',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Solo';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt2cnktX7IDVV',
  price_m_id_us = 'price_1UDRGQLr632EP5z4YI3A5cPV',
  price_y_id_us = 'price_1UDRGSLr632EP5z45R9qxkU8',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Maker';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt2xM7OyLzhqV',
  price_m_id_us = 'price_1UDRGSLr632EP5z4n0Npf7P1',
  price_y_id_us = 'price_1UDRGSLr632EP5z4jYu6vC42',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Team';

UPDATE public.plans SET
  stripe_id_us = 'prod_VDt2pia049SqpU',
  price_m_id_us = 'price_1UDRGaLr632EP5z4D02F4rLu',
  price_y_id_us = 'price_1UDRGcLr632EP5z4IxDyZuUK',
  credit_id_us = 'prod_VDt2YB5GrYFnII'
WHERE name = 'Enterprise';

-- product_id references EE plans.stripe_id or US plans.stripe_id_us.
ALTER TABLE public.stripe_info
  DROP CONSTRAINT IF EXISTS stripe_info_product_id_fkey;

CREATE OR REPLACE FUNCTION public.validate_stripe_info_product_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.billing_account = 'us' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.plans
      WHERE public.plans.stripe_id_us = NEW.product_id
    ) THEN
      RAISE EXCEPTION
        'stripe_info.product_id % is not a known US plan product id',
        NEW.product_id;
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM public.plans
      WHERE public.plans.stripe_id = NEW.product_id
    ) THEN
      RAISE EXCEPTION
        'stripe_info.product_id % is not a known EE plan product id',
        NEW.product_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.validate_stripe_info_product_id() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.validate_stripe_info_product_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_stripe_info_product_id() TO service_role;

DROP TRIGGER IF EXISTS validate_stripe_info_product_id ON public.stripe_info;

CREATE TRIGGER validate_stripe_info_product_id
  BEFORE INSERT OR UPDATE OF product_id, billing_account ON public.stripe_info
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_stripe_info_product_id();

CREATE OR REPLACE FUNCTION public.prevent_orphan_stripe_info_plan_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE public.stripe_info.billing_account = 'ee'
        AND public.stripe_info.product_id = OLD.stripe_id
    ) THEN
      RAISE EXCEPTION
        'Cannot delete plan: stripe_info rows reference plans.stripe_id %',
        OLD.stripe_id;
    END IF;

    IF OLD.stripe_id_us IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE public.stripe_info.billing_account = 'us'
        AND public.stripe_info.product_id = OLD.stripe_id_us
    ) THEN
      RAISE EXCEPTION
        'Cannot delete plan: stripe_info rows reference plans.stripe_id_us %',
        OLD.stripe_id_us;
    END IF;

    RETURN OLD;
  END IF;

  IF OLD.stripe_id IS DISTINCT FROM NEW.stripe_id AND EXISTS (
    SELECT 1
    FROM public.stripe_info
    WHERE public.stripe_info.billing_account = 'ee'
      AND public.stripe_info.product_id = OLD.stripe_id
  ) THEN
    RAISE EXCEPTION
      'Cannot change plans.stripe_id %: referenced by stripe_info (ee)',
      OLD.stripe_id;
  END IF;

  IF OLD.stripe_id_us IS DISTINCT FROM NEW.stripe_id_us
    AND OLD.stripe_id_us IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_info
      WHERE public.stripe_info.billing_account = 'us'
        AND public.stripe_info.product_id = OLD.stripe_id_us
    ) THEN
    RAISE EXCEPTION
      'Cannot change plans.stripe_id_us %: referenced by stripe_info (us)',
      OLD.stripe_id_us;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_orphan_stripe_info_plan_ids() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.prevent_orphan_stripe_info_plan_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prevent_orphan_stripe_info_plan_ids()
  TO service_role;

DROP TRIGGER IF EXISTS prevent_orphan_stripe_info_plan_ids ON public.plans;

CREATE TRIGGER prevent_orphan_stripe_info_plan_ids
  BEFORE UPDATE OF stripe_id, stripe_id_us OR DELETE ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_orphan_stripe_info_plan_ids();
