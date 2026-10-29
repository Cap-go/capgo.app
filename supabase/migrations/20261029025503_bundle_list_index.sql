-- Bundle lists filter by app and deletion state before paging by creation time.
-- Keep deleted in the key so parameterized generic plans can use the index for
-- either boolean value without depending on a partial-index predicate.
SET lock_timeout = '5s';

CREATE INDEX idx_app_versions_app_deleted_created_at
ON public.app_versions (app_id, deleted, created_at DESC);

RESET lock_timeout;
