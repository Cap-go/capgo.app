ALTER TABLE public.manifest_per_version
  ADD COLUMN size_receipts_provided boolean NOT NULL DEFAULT false,
  ADD COLUMN manifest_size bytea NULL,
  ADD COLUMN manifest_size_payload_hash bytea NULL;

ALTER TABLE public.manifest_per_version
  DROP CONSTRAINT manifest_per_version_payload_hash_check,
  DROP CONSTRAINT manifest_per_version_manifest_check,
  ADD CONSTRAINT manifest_per_version_payload_hash_check
    CHECK (
      octet_length(payload_hash) = 32
      OR octet_length(payload_hash) = 0
    ) NOT VALID,
  ADD CONSTRAINT manifest_per_version_manifest_check
    CHECK (
      octet_length(manifest) > 0
      OR octet_length(manifest) = 0
    ) NOT VALID;

ALTER TABLE public.manifest_per_version
  VALIDATE CONSTRAINT manifest_per_version_payload_hash_check,
  VALIDATE CONSTRAINT manifest_per_version_manifest_check;

COMMENT ON COLUMN public.manifest_per_version.size_receipts_provided IS
  'True when total_file_size came from signed per-file size receipts.';
