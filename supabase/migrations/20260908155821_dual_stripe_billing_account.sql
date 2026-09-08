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

COMMENT ON COLUMN public.stripe_info.billing_account IS 'Stripe Connect account for this customer: ee (Capgo OÜ legacy) or us (CodepushGo LLC).';

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS stripe_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_m_id_us character varying,
  ADD COLUMN IF NOT EXISTS price_y_id_us character varying,
  ADD COLUMN IF NOT EXISTS credit_id_us text;

COMMENT ON COLUMN public.plans.stripe_id_us IS 'Stripe product id on the US Stripe account.';
COMMENT ON COLUMN public.plans.price_m_id_us IS 'Monthly Stripe price id on the US Stripe account.';
COMMENT ON COLUMN public.plans.price_y_id_us IS 'Yearly Stripe price id on the US Stripe account.';
COMMENT ON COLUMN public.plans.credit_id_us IS 'Stripe product id for credit top-ups on the US Stripe account.';

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

-- product_id may reference either plans.stripe_id (EE) or plans.stripe_id_us (US).
ALTER TABLE public.stripe_info
  DROP CONSTRAINT IF EXISTS stripe_info_product_id_fkey;

CREATE OR REPLACE FUNCTION public.validate_stripe_info_product_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.plans
    WHERE public.plans.stripe_id = NEW.product_id
       OR public.plans.stripe_id_us = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'stripe_info.product_id % is not a known plan product id', NEW.product_id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.validate_stripe_info_product_id() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.validate_stripe_info_product_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_stripe_info_product_id() TO service_role;

DROP TRIGGER IF EXISTS validate_stripe_info_product_id ON public.stripe_info;

CREATE TRIGGER validate_stripe_info_product_id
  BEFORE INSERT OR UPDATE OF product_id ON public.stripe_info
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_stripe_info_product_id();
