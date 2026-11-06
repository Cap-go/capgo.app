-- Databases that applied the first version of 20261027220500_delta_storage_backfill
-- still declare the path key functions PARALLEL SAFE. On PostgreSQL 17, once a
-- parallel worker has taken delta_canonical_path's EXCEPTION branch, later calls
-- in that worker return the path undecoded, so a parallel backfill may have
-- stored wrong path keys. Restrict both functions to the leader and recompute
-- the keys that can differ: a path without '%' is its own canonical form.
ALTER FUNCTION public.delta_canonical_path(text) PARALLEL RESTRICTED;
ALTER FUNCTION public.delta_path_key(text) PARALLEL RESTRICTED;

SET statement_timeout = 0;

UPDATE public.delta_files
SET path_key = public.delta_path_key(s3_path)
WHERE pg_catalog.strpos(s3_path, '%') > 0
  AND path_key IS DISTINCT FROM public.delta_path_key(s3_path);

RESET statement_timeout;
