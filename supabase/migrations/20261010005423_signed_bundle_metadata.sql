-- Signed bundle metadata (encryption v2 only).
-- The CLI signs "capgo-bundle-v1\nversion:<name>\nchecksum:<sha256>\n" (zip) and
-- "capgo-manifest-v1\nversion:<name>\n<file_name>:<sha256>\n..." (manifest) with the
-- user's RSA private key; the updater plugin (>= 8.53.0) verifies both with the public
-- key from capacitor.config so version name and manifest file list cannot be swapped.
-- Values are 512 lowercase hex chars (RSA-2048 PKCS#1 v1.5 signature). NULL = unsigned
-- (legacy bundle or external encryption).
ALTER TABLE public.app_versions
ADD COLUMN IF NOT EXISTS signature text,
ADD COLUMN IF NOT EXISTS manifest_signature text;

COMMENT ON COLUMN public.app_versions.signature IS 'Hex RSA signature of the bundle version name + plaintext zip sha256 (capgo-bundle-v1). NULL when the bundle was not signed.';
COMMENT ON COLUMN public.app_versions.manifest_signature IS 'Hex RSA signature of the bundle version name + sorted manifest file_name:sha256 list (capgo-manifest-v1). NULL when the bundle was not signed.';

-- Plugin stats actions for signed metadata and on-device native-version floor.
ALTER TYPE public.stats_action ADD VALUE IF NOT EXISTS 'signature_fail';
ALTER TYPE public.stats_action ADD VALUE IF NOT EXISTS 'version_below_native';
