export type {
  IncompatibilityReason,
  NativePackage,
  PackageComparison,
  PackageStatus,
} from '../../supabase/functions/_backend/utils/bundle_compatibility.ts'

export {
  compareNativePackages as comparePackages,
  hasPlatformChecksumMetadataDrift,
  summarizeBundleCompatibility as summarizeCompatibility,
} from '../../supabase/functions/_backend/utils/bundle_compatibility.ts'
