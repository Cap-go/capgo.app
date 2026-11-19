-- Return disposable DBs to pre-20261118193000 storage lock state so the full migration SQL can re-apply.
-- Idempotent when the storage migration was never applied on the source.

DROP TRIGGER IF EXISTS close_app_storage_lifetimes ON public.apps;
DROP TRIGGER IF EXISTS guard_apps_ownership_history ON public.apps;
DROP TRIGGER IF EXISTS close_version_storage_lifetime ON public.app_versions;
DROP TRIGGER IF EXISTS close_soft_deleted_version_storage_lifetime ON public.app_versions;
DROP TRIGGER IF EXISTS open_restored_version_storage_lifetime ON public.app_versions;

DROP TABLE IF EXISTS public.daily_storage_hourly_refreshes CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    INNER JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'daily_storage_hourly'
      AND a.attname = 'cycle_start'
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.daily_storage_hourly DROP CONSTRAINT IF EXISTS daily_storage_hourly_pkey;
    ALTER TABLE public.daily_storage_hourly DROP COLUMN IF EXISTS cycle_start;
    ALTER TABLE public.daily_storage_hourly DROP COLUMN IF EXISTS segment_start;
    ALTER TABLE public.daily_storage_hourly ADD CONSTRAINT daily_storage_hourly_pkey PRIMARY KEY (app_id, date);
    ALTER TABLE public.daily_storage_hourly DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey;
    ALTER TABLE public.daily_storage_hourly
      ADD CONSTRAINT daily_storage_hourly_app_id_fkey
      FOREIGN KEY (app_id) REFERENCES public.apps (app_id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.daily_storage (
  app_id character varying,
  date date,
  storage bigint
);

INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000000'::uuid,
  '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
  'authenticated',
  'authenticated',
  'lock-test-user@example.com',
  '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi',
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{"test_identifier": "storage_lock_concurrency"}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, email)
VALUES (
  '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
  'lock-test-user@example.com'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
  '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
  'Storage lock test org',
  'lock-test-org@example.com'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, owner_org, icon_url, name)
VALUES (
  'com.demo.app',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
  '',
  'Demo'
)
ON CONFLICT (app_id) DO NOTHING;