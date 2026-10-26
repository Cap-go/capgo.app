/**
 * Light `app_versions` projection for list/picker paths.
 * Drops the large `manifest` and `native_packages` JSON arrays (same contract as
 * GET /bundle?fields=summary). Keep in sync with console list selects.
 */
export const BUNDLE_SUMMARY_COLUMNS = 'id, created_at, app_id, name, updated_at, deleted, deleted_at, external_url, checksum, session_key, storage_provider, min_update_version, owner_org, user_id, r2_path, link, comment, manifest_count, key_id, cli_version, created_by_apikey_rbac_id' as const

/** Columns needed to pick a bundle in the console channel/link dialogs. */
export const BUNDLE_PICKER_COLUMNS = 'id, name, created_at, deleted, app_id' as const
