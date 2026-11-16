-- Included Capgo Observe events per billing cycle.
-- The published allowance is a monthly sum of daily event counts.
-- Update checks, downloads, and install results stay on the live-update meters.

ALTER TABLE public.plans
  ADD COLUMN observe_events bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.plans.observe_events IS 'Included Capgo Observe events per billing cycle. Usage is the sum of daily event counts. Update-funnel stats are not part of this allowance.';

UPDATE public.plans SET observe_events = 500000 WHERE name = 'Solo';
UPDATE public.plans SET observe_events = 3000000 WHERE name = 'Maker';
UPDATE public.plans SET observe_events = 20000000 WHERE name = 'Team';
UPDATE public.plans SET observe_events = 600000000 WHERE name = 'Enterprise';
