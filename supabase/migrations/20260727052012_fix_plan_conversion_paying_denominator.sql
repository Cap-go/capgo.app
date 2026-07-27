-- Plan conversion rates are a mix among paying orgs (plan_x / paying),
-- not a conversion against all orgs/users. Keep org_conversion_rate as
-- paying / orgs. Align upgrade_rate_12m comment with the paying denominator.

COMMENT ON COLUMN public.global_stats.plan_solo_conversion_rate
  IS 'Percentage of paying organizations on the Solo plan (plan_solo / paying * 100)';

COMMENT ON COLUMN public.global_stats.plan_maker_conversion_rate
  IS 'Percentage of paying organizations on the Maker plan (plan_maker / paying * 100)';

COMMENT ON COLUMN public.global_stats.plan_team_conversion_rate
  IS 'Percentage of paying organizations on the Team plan (plan_team / paying * 100)';

COMMENT ON COLUMN public.global_stats.plan_enterprise_conversion_rate
  IS 'Percentage of paying organizations on the Enterprise plan (plan_enterprise / paying * 100)';

COMMENT ON COLUMN public.global_stats.plan_total_conversion_rate
  IS 'Percentage of paying organizations on any paid plan ((plan_solo + plan_maker + plan_team + plan_enterprise) / paying * 100)';

COMMENT ON COLUMN public.global_stats.upgrade_rate_12m
  IS 'Trailing 12-month paying-to-larger-plan upgrade events as a percentage of paying organizations (upgrade events in-window / paying * 100).';
