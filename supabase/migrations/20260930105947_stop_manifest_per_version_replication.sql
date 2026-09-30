-- Receipt summaries remain on Supabase; no plugin read path uses this table.
-- Remove the existing Supabase -> Google publication membership without
-- deleting primary or already-copied subscriber data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication
    WHERE pubname = 'capgo_google_eu_2_pub'
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'capgo_google_eu_2_pub'
      AND schemaname = 'public'
      AND tablename = 'manifest_per_version'
  ) THEN
    ALTER PUBLICATION capgo_google_eu_2_pub DROP TABLE public.manifest_per_version;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'capgo_google_eu_2_pub'
      AND schemaname = 'public'
      AND tablename = 'manifest_per_version'
  ) THEN
    RAISE EXCEPTION 'manifest_per_version remains in capgo_google_eu_2_pub';
  END IF;
END;
$$;
