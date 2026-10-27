-- Switch the live plans to the multi-currency Stripe prices (2026-10). Each price has the same USD amount
-- as before plus ~120 currencies at the market exchange rate.
-- Solo alone is priced by purchasing power: a Stripe price has one amount per currency, so each price
-- tier is its own set of prices, listed in regional_price_ids (country_price_tier.ts maps countries to
-- tiers). Maker, Team and Enterprise cost the same everywhere.
-- The old prices stay active in Stripe for existing subscriptions and are kept in alt_price_*_ids
-- (the plans trigger adds the regional IDs there too).
-- Only rows still on the old live IDs change, so local/test databases and reruns are untouched.

-- Solo
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1KkINoGH46eYKnWwwEi97h1B', 'price_1UDRGPLr632EP5z4ufTRBBzf'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1KjSNTGH46eYKnWwofmXyBZn', 'price_1UDRGULr632EP5z4OcZr5xpe'])),
  price_m_id = 'price_1UUwaeGH46eYKnWwikQlk8Y8',
  price_y_id = 'price_1UUwapGH46eYKnWwXVBNFJsM',
  price_m_id_us = 'price_1UUwcBLr632EP5z4vsqW3Tm3',
  price_y_id_us = 'price_1UUwcMLr632EP5z4pOicTG4d',
  regional_price_ids = '{
    "p85": {"price_m_id": "price_1UUwanGH46eYKnWwKvCMscEf", "price_y_id": "price_1UUwazGH46eYKnWwIMXUE2bK", "price_m_id_us": "price_1UUwcKLr632EP5z4Qpny9Utl", "price_y_id_us": "price_1UUwcVLr632EP5z4b3iWS6mZ"},
    "p70": {"price_m_id": "price_1UUwamGH46eYKnWwHrWIu0pc", "price_y_id": "price_1UUwaxGH46eYKnWwwmPm9ucX", "price_m_id_us": "price_1UUwcILr632EP5z4kKSTSjP0", "price_y_id_us": "price_1UUwcTLr632EP5z4zLghNyFO"},
    "p60": {"price_m_id": "price_1UUwakGH46eYKnWwTqUAhU4F", "price_y_id": "price_1UUwavGH46eYKnWwyAoi81OT", "price_m_id_us": "price_1UUwcGLr632EP5z43hGImJHf", "price_y_id_us": "price_1UUwcRLr632EP5z4hz1v6pNj"},
    "p50": {"price_m_id": "price_1UUwaiGH46eYKnWwRN2sZwtA", "price_y_id": "price_1UUwatGH46eYKnWwDfEM6YiL", "price_m_id_us": "price_1UUwcELr632EP5z413Gk4SQ8", "price_y_id_us": "price_1UUwcPLr632EP5z44C8bYwvE"}
  }'::jsonb,
  updated_at = now()
WHERE stripe_id = 'prod_LQIzwwVu6oMmAz'
  AND price_m_id = 'price_1KkINoGH46eYKnWwwEi97h1B';

-- Maker
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1KjSNPGH46eYKnWwVGG5HI5V', 'price_1UDRGQLr632EP5z4YI3A5cPV'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1NsEbJGH46eYKnWwkOoCqT95', 'price_1UDRGSLr632EP5z45R9qxkU8'])),
  price_m_id = 'price_1UUwaHGH46eYKnWwLIx4RLTA',
  price_y_id = 'price_1UUwaSGH46eYKnWwciOD6FPL',
  price_m_id_us = 'price_1UUwbqLr632EP5z4uNWoVy9j',
  price_y_id_us = 'price_1UUwc0Lr632EP5z4gf5d5SVF',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzozukEwDZDM'
  AND price_m_id = 'price_1KjSNPGH46eYKnWwVGG5HI5V';

-- Team
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1KjSNKGH46eYKnWw32bhz1xX', 'price_1UDRGSLr632EP5z4n0Npf7P1'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1KjSNKGH46eYKnWwx0pSkXE6', 'price_1UDRGSLr632EP5z4jYu6vC42'])),
  price_m_id = 'price_1UUwb1GH46eYKnWwkzg0rWnP',
  price_y_id = 'price_1UUwbDGH46eYKnWwQUX32Fzb',
  price_m_id_us = 'price_1UUwcXLr632EP5z4iew5VirD',
  price_y_id_us = 'price_1UUwciLr632EP5z49j8WcWQk',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzm2NGzayzXi'
  AND price_m_id = 'price_1KjSNKGH46eYKnWw32bhz1xX';

-- Enterprise
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1On9Z7GH46eYKnWws8CBfcHQ', 'price_1UDRGaLr632EP5z4D02F4rLu'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1Sdu3rGH46eYKnWwK9x8sdK4', 'price_1UDRGcLr632EP5z4IxDyZuUK'])),
  price_m_id = 'price_1UUwZuGH46eYKnWwoBF1Wjo9',
  price_y_id = 'price_1UUwa6GH46eYKnWw95XJawmq',
  price_m_id_us = 'price_1UUwbULr632EP5z4Kn9Fe0Zj',
  price_y_id_us = 'price_1UUwbeLr632EP5z4fFSSWXja',
  updated_at = now()
WHERE stripe_id = 'prod_MIy30G5ywsjiUu'
  AND price_m_id = 'price_1On9Z7GH46eYKnWws8CBfcHQ';
