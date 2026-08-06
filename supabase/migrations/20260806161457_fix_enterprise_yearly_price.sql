-- Enterprise yearly price was left at 4799 from the old $499/mo plan.
-- Align with public pricing ($2490/year ≈ $208/mo, ~same discount ratio as other plans).
UPDATE public.plans
SET price_y = 2490
WHERE name = 'Enterprise'
  AND price_y = 4799;
