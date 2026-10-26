-- Switch the live plans to the PPP-priced Stripe prices (2026-10): each carries per-currency amounts that
-- the old prices could not take (Stripe never changes an existing currency_options amount).
-- The old prices stay active in Stripe for existing subscriptions and are recorded as legacy IDs.
-- Only rows still on the old live IDs change, so local/test databases and reruns are untouched.

-- Solo
UPDATE public.plans SET
  legacy_price_m_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_m_ids || ARRAY['price_1KkINoGH46eYKnWwwEi97h1B', 'price_1UDRGPLr632EP5z4ufTRBBzf'])),
  legacy_price_y_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_y_ids || ARRAY['price_1KjSNTGH46eYKnWwofmXyBZn', 'price_1UDRGULr632EP5z4OcZr5xpe'])),
  price_m_id = 'price_1UUoLsGH46eYKnWwMMnYWRUt',
  price_y_id = 'price_1UUoLtGH46eYKnWwK5qazmRa',
  price_m_id_us = 'price_1UUoM5Lr632EP5z4GQAWeA9v',
  price_y_id_us = 'price_1UUoM6Lr632EP5z4saTO1DgJ',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzwwVu6oMmAz'
  AND price_m_id = 'price_1KkINoGH46eYKnWwwEi97h1B';

-- Maker
UPDATE public.plans SET
  legacy_price_m_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_m_ids || ARRAY['price_1KjSNPGH46eYKnWwVGG5HI5V', 'price_1UDRGQLr632EP5z4YI3A5cPV'])),
  legacy_price_y_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_y_ids || ARRAY['price_1NsEbJGH46eYKnWwkOoCqT95', 'price_1UDRGSLr632EP5z45R9qxkU8'])),
  price_m_id = 'price_1UUoLuGH46eYKnWwOzxCV1s8',
  price_y_id = 'price_1UUoLvGH46eYKnWwg0QzPC7s',
  price_m_id_us = 'price_1UUoM7Lr632EP5z46szVL5Fm',
  price_y_id_us = 'price_1UUoM8Lr632EP5z4SdyQGBb5',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzozukEwDZDM'
  AND price_m_id = 'price_1KjSNPGH46eYKnWwVGG5HI5V';

-- Team
UPDATE public.plans SET
  legacy_price_m_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_m_ids || ARRAY['price_1KjSNKGH46eYKnWw32bhz1xX', 'price_1UDRGSLr632EP5z4n0Npf7P1'])),
  legacy_price_y_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_y_ids || ARRAY['price_1KjSNKGH46eYKnWwx0pSkXE6', 'price_1UDRGSLr632EP5z4jYu6vC42'])),
  price_m_id = 'price_1UUoLwGH46eYKnWwVsx84a0U',
  price_y_id = 'price_1UUoLxGH46eYKnWwL6eV6Ven',
  price_m_id_us = 'price_1UUoM9Lr632EP5z4yTAqS9yR',
  price_y_id_us = 'price_1UUoMALr632EP5z47k5zj6r0',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzm2NGzayzXi'
  AND price_m_id = 'price_1KjSNKGH46eYKnWw32bhz1xX';

-- Enterprise
UPDATE public.plans SET
  legacy_price_m_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_m_ids || ARRAY['price_1On9Z7GH46eYKnWws8CBfcHQ', 'price_1UDRGaLr632EP5z4D02F4rLu'])),
  legacy_price_y_ids = ARRAY(SELECT DISTINCT unnest(legacy_price_y_ids || ARRAY['price_1Sdu3rGH46eYKnWwK9x8sdK4', 'price_1UDRGcLr632EP5z4IxDyZuUK'])),
  price_m_id = 'price_1UUoLyGH46eYKnWwgqGHinY9',
  price_y_id = 'price_1UUoLyGH46eYKnWwSxWg7q9u',
  price_m_id_us = 'price_1UUoMBLr632EP5z4DR7dTatN',
  price_y_id_us = 'price_1UUoMCLr632EP5z4A1GPlvzO',
  updated_at = now()
WHERE stripe_id = 'prod_MIy30G5ywsjiUu'
  AND price_m_id = 'price_1On9Z7GH46eYKnWws8CBfcHQ';
