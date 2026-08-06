// src/build/prescan/registry.ts
import type { PrescanCheck } from './types'
import {
  manifestDeeplinkValid,
  manifestDuplicateComponent,
  manifestExportedMissing,
  manifestExportedUnprotected,
  manifestHardcodedDebuggable,
  manifestMissingPrefix,
  manifestMockLocation,
  manifestMultipleUsesSdk,
  manifestNamespaceUri,
  manifestQueryAllPackages,
  manifestTagTypo,
  manifestUniquePermission,
  manifestWellFormed,
} from './checks/android-manifest'
import { keystoreExpiry, keystoreOpens } from './checks/android-keystore'
import {
  agp8PackageAttr,
  applicationIdPresent,
  capacitorBuildGradleApplied,
  cordovaVarsPresent,
  flavorDimensions,
  flavorExists,
  googleServicesFile,
  gradlePropsHeuristics,
  gradleWrapperPresent,
  localPropertiesCommitted,
  minSdkCapacitor,
  playSaJson,
  sdkFloors,
  targetSdkPlay,
  versionFields,
} from './checks/android-project'
import { credentialsSaved } from './checks/credentials'
import { ascKeyValid, p12Expiry, p12Opens } from './checks/ios-certs'
import { infoplistSanity } from './checks/ios-plist'
import { certProfilePairing, profileBundleMatch, profileExpiry, profileTypeVsMode, targetsCovered } from './checks/ios-profiles'
import {
  allowNavigationWildcard,
  serverCleartext,
  serverUrlShipped,
} from './checks/ios-capacitor-config'
import {
  appGroupsFormat,
  apsEnvironmentVsMode,
  associatedDomainsFormat,
  entitlementsVsProfileCapability,
} from './checks/ios-entitlements-checks'
import {
  plistAtsArbitraryLoads,
  plistBackgroundModesSanity,
  plistBundleIdFormat,
  plistDisplayName,
  plistEncryptionCompliance,
  plistLaunchStoryboard,
  plistOrientationsMultitasking,
  plistOrientationsPresent,
  plistVersionBuildFormat,
  plistVersionShortFormat,
} from './checks/ios-plist-checks'
import {
  appiconEmptyOrPlaceholder,
  appiconMarketingMissing,
  appiconReferencedFileMissing,
  podsCapacitorMissing,
  podsLockMissing,
  podsNotInstalled,
  spmCapacitorDependencyMissing,
  spmDeploymentTargetConsistency,
  spmPackageResolvedMissing,
} from './checks/ios-pods-assets'
import {
  bundleIdMismatchAcrossConfigs,
  deploymentTargetCapacitor,
  enableBitcodeLeftover,
  multipleAppTargets,
  noAppTarget,
  signingTeam,
  swiftVersionSanity,
} from './checks/ios-xcode'
import { bundleIdConsistency, capSyncStale, nodeLinkerLayout } from './checks/shared'
import { apikeyPermission, appExists } from './checks/shared-remote'
import { ascKeyAccess, playSaAccess } from './checks/store-access'

/** New iOS expansion checks become build-blocking at this UTC instant. */
export const IOS_PRESCAN_EXPANSION_ENFORCE_AFTER = '2026-08-14T00:00:00.000Z'

const IOS_EXPANSION_CHECKS: PrescanCheck[] = [
  // ios plist (Info.plist / App Store)
  plistBundleIdFormat, plistVersionShortFormat, plistVersionBuildFormat,
  plistEncryptionCompliance, plistAtsArbitraryLoads, plistLaunchStoryboard,
  plistOrientationsMultitasking, plistOrientationsPresent, plistDisplayName,
  plistBackgroundModesSanity,
  // ios xcode (project / build settings)
  deploymentTargetCapacitor, signingTeam, bundleIdMismatchAcrossConfigs,
  enableBitcodeLeftover, swiftVersionSanity, noAppTarget,
  multipleAppTargets,
  // ios entitlements / capabilities
  entitlementsVsProfileCapability, apsEnvironmentVsMode,
  associatedDomainsFormat, appGroupsFormat,
  // ios capacitor config
  serverUrlShipped, serverCleartext, allowNavigationWildcard,
  // ios pods / spm / app icons
  podsNotInstalled, podsLockMissing, podsCapacitorMissing,
  spmPackageResolvedMissing, spmCapacitorDependencyMissing, appiconEmptyOrPlaceholder,
  appiconReferencedFileMissing, appiconMarketingMissing, spmDeploymentTargetConsistency,
].map(check => ({ ...check, enforceAfter: IOS_PRESCAN_EXPANSION_ENFORCE_AFTER }))

export const ALL_CHECKS: PrescanCheck[] = [
  // shared
  apikeyPermission, appExists, credentialsSaved,
  capSyncStale, nodeLinkerLayout, bundleIdConsistency,
  // ios certs / profiles / plist
  p12Opens, p12Expiry, profileExpiry, profileBundleMatch, profileTypeVsMode,
  certProfilePairing, targetsCovered, infoplistSanity, ascKeyValid,
  // android keystore / project
  keystoreOpens, keystoreExpiry, cordovaVarsPresent, gradlePropsHeuristics,
  playSaJson, flavorExists, agp8PackageAttr,
  // android manifest
  manifestWellFormed, manifestTagTypo, manifestNamespaceUri,
  manifestMissingPrefix, manifestExportedMissing, manifestMultipleUsesSdk,
  manifestDuplicateComponent, manifestUniquePermission, manifestHardcodedDebuggable,
  manifestMockLocation, manifestExportedUnprotected, manifestQueryAllPackages,
  manifestDeeplinkValid,
  // android gradle / project
  applicationIdPresent, capacitorBuildGradleApplied, gradleWrapperPresent,
  flavorDimensions, googleServicesFile, localPropertiesCommitted,
  sdkFloors, targetSdkPlay, minSdkCapacitor, versionFields,
  // store-access (remote)
  playSaAccess, ascKeyAccess,
  ...IOS_EXPANSION_CHECKS,
]

/** Stable list of registered check ids for CLI override validation. */
export const ALL_CHECK_IDS: string[] = ALL_CHECKS.map(check => check.id)
