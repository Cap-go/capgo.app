import type { Database } from '~/types/database.types'

// Re-export the shared light app_versions projections used by GET /bundle?fields=summary
// and console list/picker paths so list pages never pull manifest / native_packages.
export {
  BUNDLE_PICKER_COLUMNS,
  BUNDLE_SUMMARY_COLUMNS,
} from '../../supabase/functions/shared/bundle-columns.ts'

type AppVersionRow = Database['public']['Tables']['app_versions']['Row']

/** List/picker row: every column except the heavy JSON arrays. */
export type BundleSummaryRow = Omit<AppVersionRow, 'manifest' | 'native_packages'>

/** Detail row when native_packages are needed but the legacy manifest blob is not. */
export type BundleSummaryWithNativePackages = Omit<AppVersionRow, 'manifest'>

/** Channel/link dialog picker row. */
export type BundlePickerRow = Pick<AppVersionRow, 'id' | 'name' | 'created_at' | 'deleted' | 'app_id'>
