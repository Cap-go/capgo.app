-- One binary manifest per app version. Keep this table private until
-- the read path, rollout, and replica publication are defined separately.
CREATE TABLE public.manifest_per_version (
    version_id bigint PRIMARY KEY
    REFERENCES public.app_versions (id) ON DELETE CASCADE,
    format_version smallint NOT NULL,
    entry_count integer NOT NULL,
    total_file_size bigint NOT NULL,
    payload_hash bytea NOT NULL,
    manifest bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT manifest_per_version_format_version_check
    CHECK (format_version >= 0),
    CONSTRAINT manifest_per_version_entry_count_check
    CHECK (entry_count >= 0),
    CONSTRAINT manifest_per_version_total_file_size_check
    CHECK (total_file_size >= 0),
    CONSTRAINT manifest_per_version_payload_hash_check
    CHECK (octet_length(payload_hash) = 32),
    CONSTRAINT manifest_per_version_manifest_check
    CHECK (octet_length(manifest) > 0)
);

ALTER TABLE public.manifest_per_version OWNER TO postgres;
ALTER TABLE public.manifest_per_version REPLICA IDENTITY DEFAULT;
ALTER TABLE public.manifest_per_version ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.manifest_per_version TO service_role;
REVOKE ALL ON TABLE public.manifest_per_version FROM public;
REVOKE ALL ON TABLE public.manifest_per_version FROM anon;
REVOKE ALL ON TABLE public.manifest_per_version FROM authenticated;
