-- Delta storage v2, step 4: foreign keys of the new tables. NOT VALID keeps
-- this short (it only takes brief locks on apps and app_versions); from here
-- on deletes cascade. delta_storage_validate checks the existing rows.

SET lock_timeout = '5s';

ALTER TABLE public.delta_files
  ADD CONSTRAINT delta_files_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps (app_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.version_files
  ADD CONSTRAINT version_files_app_version_id_fkey FOREIGN KEY (app_version_id) REFERENCES public.app_versions (id) ON DELETE CASCADE NOT VALID;

RESET lock_timeout;
