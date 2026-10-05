-- MAU tiers above 1M: stop the price jump after the Enterprise plan.
--
-- The Enterprise plan includes 1M MAU for $249 ($0.000249/MAU), but the
-- next tier charged $0.0006/MAU, 2.4x the plan rate. 2M MAU cost $849 and
-- 3M cost $1,449, so the average price per MAU nearly doubled as a
-- customer grew. The 1M-3M tier now costs $0.0003/MAU, 1.2x the plan rate
-- (2M = $549, 3M = $849), and every tier after it is cheaper. The average
-- price per MAU stays between $0.000249 and $0.000283 up to 6M, then goes
-- down.
--
-- The 0-1M tier stays at $0.003/MAU. Tiers follow total volume, so an org
-- without a plan still pays $3,000 for its first 1M MAU and can never
-- undercut a plan.
--
-- Per 1k MAU:
--   1M-3M     $0.60 -> $0.30
--   3M-6M     $0.45 -> $0.25
--   6M-10M    $0.35 -> $0.20
--   10M-25M   $0.25 -> $0.18
--   25M-100M  $0.18 -> $0.15
--   100M+     $0.12 -> $0.10
--
-- Tier boundaries do not change; rows are re-priced in place so
-- usage_overage_events.credit_step_id references keep their row.

UPDATE public.capgo_credits_steps AS s
SET price_per_unit = n.price_per_unit
FROM (
    VALUES
    (1000000::bigint, 3000000::bigint, 0.0003::double precision),
    (3000000::bigint, 6000000::bigint, 0.00025::double precision),
    (6000000::bigint, 10000000::bigint, 0.0002::double precision),
    (10000000::bigint, 25000000::bigint, 0.00018::double precision),
    (25000000::bigint, 100000000::bigint, 0.00015::double precision),
    (100000000::bigint, 9223372036854775807::bigint, 0.0001::double precision)
) AS n (step_min, step_max, price_per_unit)
WHERE
    s.type = 'mau'
    AND s.org_id IS NULL
    AND s.step_min = n.step_min
    AND s.step_max = n.step_max;
