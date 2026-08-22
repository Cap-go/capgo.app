ALTER TABLE public.users
DROP CONSTRAINT users_onboarding_valid;

ALTER TABLE public.users
ADD CONSTRAINT users_onboarding_valid CHECK (
    jsonb_typeof(onboarding) = 'object'
    AND octet_length(onboarding::text) <= 65536
    AND (
        NOT (onboarding ? 'status')
        OR (
            jsonb_typeof(onboarding -> 'status') = 'string'
            AND onboarding ->> 'status'
            = any(ARRAY['in_progress', 'completed', 'abandoned'])
        )
    )
    AND (
        NOT (onboarding ? 'step')
        OR (
            jsonb_typeof(onboarding -> 'step') = 'string'
            AND onboarding ->> 'step'
            = any(
                ARRAY[
                    'intent',
                    'details',
                    'organization',
                    'choice',
                    'install',
                    'setup'
                ]
            )
        )
    )
    AND (
        NOT (onboarding ? 'flow')
        OR (
            jsonb_typeof(onboarding -> 'flow') = 'string'
            AND onboarding ->> 'flow' = any(ARRAY['pre_org', 'existing_org'])
        )
    )
    AND (
        NOT (onboarding ? 'intent')
        OR (
            jsonb_typeof(onboarding -> 'intent') = 'string'
            AND onboarding ->> 'intent'
            = any(ARRAY['ota', 'builder', 'both', 'exploring'])
        )
    )
) NOT VALID;
