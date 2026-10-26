-- Switch the live plans to regional (PPP) Stripe prices (2026-10). A Stripe price has one amount per
-- currency, so each price tier is its own set of prices: the full-price tier (p100) goes in
-- price_m_id / price_y_id (+ _us), the others in regional_price_ids; country_price_tier.ts maps each
-- country to a tier. The old prices stay active in Stripe for existing subscriptions and are kept in
-- alt_price_*_ids (the plans trigger adds the regional IDs there too).
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
    "p115": {"price_m_id": "price_1UUwagGH46eYKnWwW4tlFunA", "price_y_id": "price_1UUwarGH46eYKnWwycYysqRw", "price_m_id_us": "price_1UUwcDLr632EP5z4GXoI9Y3g", "price_y_id_us": "price_1UUwcOLr632EP5z4srp3BeYE"},
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
  regional_price_ids = '{
    "p115": {"price_m_id": "price_1UUwaJGH46eYKnWwjD6TOW5n", "price_y_id": "price_1UUwaUGH46eYKnWwJ2kN0KgU", "price_m_id_us": "price_1UUwbrLr632EP5z4KJY46E2Q", "price_y_id_us": "price_1UUwc2Lr632EP5z46fofeEJR"},
    "p85": {"price_m_id": "price_1UUwaQGH46eYKnWweWloJCFW", "price_y_id": "price_1UUwacGH46eYKnWw9oeOKFpX", "price_m_id_us": "price_1UUwbzLr632EP5z4dKkByzic", "price_y_id_us": "price_1UUwc9Lr632EP5z4UuNL8Eyw"},
    "p70": {"price_m_id": "price_1UUwaPGH46eYKnWwEqMSm4cf", "price_y_id": "price_1UUwaaGH46eYKnWw1oTHN5Xf", "price_m_id_us": "price_1UUwbxLr632EP5z4TJCo2UcK", "price_y_id_us": "price_1UUwc7Lr632EP5z4d1Kh92BX"},
    "p60": {"price_m_id": "price_1UUwaNGH46eYKnWwO1eNdl3u", "price_y_id": "price_1UUwaYGH46eYKnWwoBlQSG01", "price_m_id_us": "price_1UUwbvLr632EP5z4hYtu2gbr", "price_y_id_us": "price_1UUwc6Lr632EP5z4aR3JownG"},
    "p50": {"price_m_id": "price_1UUwaLGH46eYKnWwIW85jEsZ", "price_y_id": "price_1UUwaWGH46eYKnWwFaQi3yUa", "price_m_id_us": "price_1UUwbtLr632EP5z4k1JWBMow", "price_y_id_us": "price_1UUwc4Lr632EP5z4suqIJvJx"}
  }'::jsonb,
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
  regional_price_ids = '{
    "p115": {"price_m_id": "price_1UUwb3GH46eYKnWwHzxiqYE8", "price_y_id": "price_1UUwbFGH46eYKnWwyNDOQaur", "price_m_id_us": "price_1UUwcZLr632EP5z4mP4RmzjF", "price_y_id_us": "price_1UUwckLr632EP5z4oFLyv2f0"},
    "p85": {"price_m_id": "price_1UUwbBGH46eYKnWwefPsSSdz", "price_y_id": "price_1UUwbNGH46eYKnWwlT2pw5DC", "price_m_id_us": "price_1UUwcgLr632EP5z4p4BdHL6h", "price_y_id_us": "price_1UUwcrLr632EP5z4u1eAOTgI"},
    "p70": {"price_m_id": "price_1UUwb9GH46eYKnWwUjZJlGSs", "price_y_id": "price_1UUwbKGH46eYKnWwywVwfwL7", "price_m_id_us": "price_1UUwceLr632EP5z43QUEGw1S", "price_y_id_us": "price_1UUwcpLr632EP5z4GcabVtXh"},
    "p60": {"price_m_id": "price_1UUwb7GH46eYKnWwkUkN23Ec", "price_y_id": "price_1UUwbIGH46eYKnWwmtjjI1ex", "price_m_id_us": "price_1UUwccLr632EP5z4tbe0Zniq", "price_y_id_us": "price_1UUwcnLr632EP5z4fpL5xg4a"},
    "p50": {"price_m_id": "price_1UUwb5GH46eYKnWwBGX3cwb4", "price_y_id": "price_1UUwbGGH46eYKnWwVEGO3T5h", "price_m_id_us": "price_1UUwcbLr632EP5z45ILx2o5T", "price_y_id_us": "price_1UUwcmLr632EP5z4SAv6FBx7"}
  }'::jsonb,
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
  regional_price_ids = '{
    "p115": {"price_m_id": "price_1UUwZwGH46eYKnWwqbHwoOgz", "price_y_id": "price_1UUwa8GH46eYKnWwlWvFsAig", "price_m_id_us": "price_1UUwbVLr632EP5z47wEycv5n", "price_y_id_us": "price_1UUwbgLr632EP5z4fGNkgQCA"},
    "p85": {"price_m_id": "price_1UUwa4GH46eYKnWwRRUfBgId", "price_y_id": "price_1UUwaFGH46eYKnWwSGI3QqxO", "price_m_id_us": "price_1UUwbcLr632EP5z45OFDm5Kt", "price_y_id_us": "price_1UUwboLr632EP5z48SzbYniW"},
    "p70": {"price_m_id": "price_1UUwa2GH46eYKnWwDB5fHqmK", "price_y_id": "price_1UUwaDGH46eYKnWwF7mDz9Ml", "price_m_id_us": "price_1UUwbbLr632EP5z4mR6CTeXn", "price_y_id_us": "price_1UUwbmLr632EP5z40Dt8iAQA"},
    "p60": {"price_m_id": "price_1UUwa0GH46eYKnWwi2UxwYpr", "price_y_id": "price_1UUwaCGH46eYKnWwdzgOS2h5", "price_m_id_us": "price_1UUwbZLr632EP5z4zpTE8oiH", "price_y_id_us": "price_1UUwbkLr632EP5z4EAdURb9T"},
    "p50": {"price_m_id": "price_1UUwZyGH46eYKnWwNFKk6bDJ", "price_y_id": "price_1UUwaAGH46eYKnWwEWlHnXO5", "price_m_id_us": "price_1UUwbXLr632EP5z4tf5srej3", "price_y_id_us": "price_1UUwbiLr632EP5z46TSySH0O"}
  }'::jsonb,
  updated_at = now()
WHERE stripe_id = 'prod_MIy30G5ywsjiUu'
  AND price_m_id = 'price_1On9Z7GH46eYKnWws8CBfcHQ';
