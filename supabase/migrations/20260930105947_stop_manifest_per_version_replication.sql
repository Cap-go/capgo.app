-- Receipt summaries remain on Supabase; no plugin read path uses this table.
-- Remove the existing Supabase -> Google publication membership without
-- deleting primary or already-copied subscriber data.
DO $$
DECLARE
  publication_name text;
BEGIN
  FOR publication_name IN
    SELECT pubname
    FROM pg_catalog.pg_publication
    WHERE pubname IN ('capgo_google_eu_2_pub', 'capgo_google_replicate')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_publication_tables
      WHERE pubname = publication_name
        AND schemaname = 'public'
        AND tablename = 'manifest_per_version'
    ) THEN
      EXECUTE format('ALTER PUBLICATION %I DROP TABLE public.manifest_per_version', publication_name);
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_publication_tables
      WHERE pubname = publication_name
        AND schemaname = 'public'
        AND tablename = 'manifest_per_version'
    ) THEN
      RAISE EXCEPTION 'manifest_per_version remains in %', publication_name;
    END IF;
  END LOOP;
END;
$$;
