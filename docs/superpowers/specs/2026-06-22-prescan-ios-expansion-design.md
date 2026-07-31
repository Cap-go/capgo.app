# Prescan iOS Expansion — Implementation-Ready Design

Status: design (no code in this phase)
Branch: `wolny/prescan-ios-expansion`
Date: 2026-06-22
Author: lead designer (merge of 4 research outputs)

## 0. Scope & ground truth

This spec merges four iOS prescan research outputs (Info.plist/App Store, Xcode
project/build settings, Entitlements/Capacitor config, Pods/SPM/App icons) into
ONE deduplicated, TDD-ready check pack. It is grounded against a real Capacitor 8
SPM project at
`/Users/michaltremblay/Developer/capgo-saas/capgo_builder/tutorial-app/ios`.

### Verified ground-truth facts (drive the FP guards)

- Info.plist stores **build-variable references**, not literals:
  `CFBundleIdentifier=$(PRODUCT_BUNDLE_IDENTIFIER)`, `CFBundleShortVersionString=$(MARKETING_VERSION)`,
  `CFBundleVersion=$(CURRENT_PROJECT_VERSION)`, `CFBundleName=$(PRODUCT_NAME)`.
  CFBundleDisplayName is a **literal** (`Tutorial Build example app`).
  → `resolvePlistValue()` substitution is the single biggest false-positive guard.
- `LSRequiresIPhoneOS=<true/>`, `UILaunchStoryboardName=LaunchScreen` present.
- `UISupportedInterfaceOrientations` (iPhone) is MISSING `PortraitUpsideDown`;
  `UISupportedInterfaceOrientations~ipad` has all four. → multitasking check MUST
  read the `~ipad` array only.
- `App.entitlements` = `{ aps-environment: development }` only. → the universal
  Capacitor default leftover; on this push-free app the aps-vs-mode check surfaces it
  as a **warning** (not a build-blocking error) under app_store, so the grounding
  project still scans clean of errors; no app-groups/iCloud/associated-domains.
- pbxproj target (Debug+Release identical): `CODE_SIGN_STYLE=Automatic`,
  `DEVELOPMENT_TEAM=UVTJ336J2D`, `IPHONEOS_DEPLOYMENT_TARGET=15.0`,
  `SWIFT_VERSION=5.0`, `TARGETED_DEVICE_FAMILY="1,2"` (iPad-capable),
  `PRODUCT_BUNDLE_IDENTIFIER=app.capgo.plugin.TutorialBuild` (same in both configs),
  `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon`, `MARKETING_VERSION=1.0`,
  `CURRENT_PROJECT_VERSION=1`. `ENABLE_BITCODE` ABSENT. Project-level config blocks
  only carry `IPHONEOS_DEPLOYMENT_TARGET`.
- SPM-only layout: NO `Podfile`, NO `Pods/`, NO `App.xcworkspace`.
  `Package.swift` = `platforms: [.iOS(.v15)]`, depends on `capacitor-swift-pm` exact `8.3.1`,
  `.product(name: "Capacitor", ...)` + `.product(name: "Cordova", ...)`.
  `Package.resolved` at `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
- `AppIcon.appiconset/Contents.json`: single universal `1024x1024` entry,
  `filename=AppIcon-512@2x.png`, file present.

**Every check below produces NO finding against this healthy project** (the
acceptance baseline for TDD: the grounding project must scan clean).

### Engine facts that constrain check authoring

- `Finding.id` is the check id; existing checks reuse the same id across all
  findings they emit (mirror this — do NOT invent per-finding ids).
- Each `run()` is crash- and timeout-isolated (10s) and degrades to an `info`
  notice; `appliesTo` is crash-isolated too. So a `run()` that throws is safe,
  but checks should still early-return `[]` on missing files for clean output.
- `Finding.detail/title/fix` are printed and serialized to `--json` (CI logs):
  NEVER embed credential material. All checks here read only project files, so
  this is naturally satisfied (the one credential-adjacent input is the
  provisioning map, and we only surface entitlement KEY names + bundle ids).
- `ctx.config` is a Capacitor config with `.passthrough()` — `ctx.config?.server?.url`
  / `.cleartext` / `.allowNavigation` are reachable with safe optional access; no
  parser needed.
- `willUploadToAppStore(ctx)` already exists (upload-intent.ts): iOS + mode
  `app_store` (default when undefined) + full ASC triplet
  (`APPLE_KEY_ID`+`APPLE_ISSUER_ID`+`APPLE_KEY_CONTENT`).
- `parseProvisioningMap(ctx)` + `hasMap` live in ios-profiles.ts; `bundleMatches()`
  (wildcard-aware) is local to that file — extract/share for entitlement subset checks.

---

## 1. Parsing infrastructure (new files + reuse)

NO new npm deps. NO fast-xml-parser (deliberately removed). Targeted regex for
plist/pbxproj/Podfile/Package.swift (XML/pbx text), `JSON.parse` for Contents.json
and package.json (already JSON). All readers use `existsSync`/`readFileSync`
(node:fs) + `join` (node:path) and return null/[]/false on absence — never throw.

### 1.1 `cli/src/build/prescan/checks/ios-plist-read.ts` (NEW — shared plist value reader)

Promotes the private `plistStringValue` from ios-plist.ts and adds the value-typed
readers the new checks need. Keep `SCHEME_RE` where it is (ios-plist.ts) or re-export.

```ts
plistString(raw, key): string | null      // top-level <key>K</key><string>V</string> (= existing plistStringValue)
plistBool(raw, key): boolean | null        // <key>K</key>\s*<(true|false)/> ; null when key absent
plistHasKey(raw, key): boolean             // raw.includes(`<key>${key}</key>`) (presence only)
plistArrayStrings(raw, key): string[]      // <key>K</key>\s*<array>...</array> -> its <string> children
plistDictBlock(raw, key): string | null    // inner text of <key>K</key>\s*<dict>...</dict>, ONE level non-greedy
```

- `plistArrayStrings` generalizes the existing CFBundleURLSchemes block+children
  pattern (ios-plist.ts L55-58). Needed for orientations + UIBackgroundModes.
- `plistDictBlock` matches `extractNestedPlistValue`'s dict-capture regex
  (mobileprovision-parser.ts L198). ONE-level nesting only — document the limit
  like `resolveBundleId`. Needed to scope NSAppTransportSecurity reads.
- Regex notes: build all `key` regexes with the existing `escapeRegex` pattern;
  arrays/dicts use `[\s\S]*?` (non-greedy) so the first closing tag wins.

### 1.2 `cli/src/build/prescan/ios-buildsettings.ts` (NEW — pbxproj scalar + plist-var resolver)

Two cross-file resolvers. Implemented standalone here (rather than mutating
pbxproj-parser) to keep the existing signing pipeline untouched; both reuse
`readPbxproj` from pbxproj-parser.ts.

```ts
readBuildSetting(pbxContent, name): string | null
// Release-preferred scalar lookup, mirroring resolveBundleId's Release-vs-fallback walk.
// Generalize pbxproj-parser L82-103: per build-config block, match `NAME = "?VALUE"?;`
// (strip quotes). Return the Release value if any config is named Release; else the
// first non-null value found (fallback). SCALAR keys only — never array-valued settings.

resolvePlistValue(rawValue, pbxContent): string
// If rawValue is exactly one $(VAR) or ${VAR} reference, substitute via readBuildSetting(VAR).
// Else return rawValue unchanged. EVERY value-format check pipes the plist value through
// this before validating. If the var has no pbxproj match, return the raw $() string
// (callers treat a still-unresolved $() as "skip / cannot judge").
```

### 1.3 `cli/src/build/prescan/ios-pbxsettings.ts` helper OR extend ios-buildsettings (NEW — per-config + per-target)

For signing / per-config / swift checks we need ALL configs, not just Release-preferred:

```ts
interface BuildConfig { name: string; settings: Record<string,string>; isProjectLevel: boolean }
readBuildConfigs(pbxContent): BuildConfig[]
// Generalize the buildConfig block walk (pbxproj-parser L82-96): for every
// XCBuildConfiguration block capture name (L95 regex) + all `KEY = "?VALUE"?;` scalar pairs.
// isProjectLevel = referenced by the PBXProject's buildConfigurationList (find the
// `isa = PBXProject` block, read its buildConfigurationList id, mark those configs).

interface TargetConfigs { target: PbxTarget; configs: { name: string; settings: Record<string,string> }[] }
readTargetConfigs(pbxContent): TargetConfigs[]
// For each signable target (reuse findSignableTargets + its configList walk), capture
// the FULL settings dict per config (Debug/Release) in the same pass resolveBundleId uses.
```

CRITICAL parser caveat (drives "skip absent key" rule everywhere): the one-level
nested-brace cap means **array-valued settings** (`LD_RUNPATH_SEARCH_PATHS = ( ... )`,
`GCC_PREPROCESSOR_DEFINITIONS`) may be captured raw/truncated. Checks MUST only rely
on **scalar** keys (`IPHONEOS_DEPLOYMENT_TARGET`, `CODE_SIGN_STYLE`, `DEVELOPMENT_TEAM`,
`SWIFT_VERSION`, `ENABLE_BITCODE`, `PRODUCT_BUNDLE_IDENTIFIER`, `TARGETED_DEVICE_FAMILY`,
`ASSETCATALOG_COMPILER_APPICON_NAME`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`,
`PRODUCT_NAME`). Build-setting inheritance/xcconfig is NOT resolved: an ABSENT scalar
key == "unknown/inherited" → SKIP (no finding). Only flag a PRESENT bad value.

### 1.4 `cli/src/build/prescan/ios-entitlements.ts` (NEW — app + profile entitlements)

```ts
// App's own entitlements file. Capacitor convention: ios/App/App/App.entitlements
// (future enhancement: resolve via pbxproj CODE_SIGN_ENTITLEMENTS; default path is reliable).
readAppEntitlements(projectDir): { raw: string } | null     // null when file absent
entString(raw, key): string | null                          // reuse plistString
entArray(raw, key): string[]                                 // reuse plistArrayStrings
entBool(raw, key): boolean | null                            // reuse plistBool
```

Profile entitlements: extend `MobileprovisionDetail` (mobileprovision-parser.ts) with a
`profileEntitlements` accessor. Reuse the existing `extractNestedPlistValue` dict-capture
for the `<key>Entitlements</key><dict>` block, plus an array-aware sibling (the
DeveloperCertificates array regex L167 is the template) to read these keys from inside
that dict: `aps-environment` (string), `com.apple.security.application-groups` (array),
`com.apple.developer.associated-domains` (array), `com.apple.developer.icloud-container-identifiers`
(array), `com.apple.developer.icloud-services` (array), `com.apple.developer.ubiquity-kvstore-identifier`
(string), `com.apple.developer.healthkit` (bool), `keychain-access-groups` (array),
`com.apple.developer.in-app-payments` (array), `com.apple.developer.networking.*` (array/bool),
`get-task-allow` (bool). ~30-50 lines, no new deps. Expose as a structured getter so
checks read `profileEntitlements[key]` rather than re-parsing.

### 1.5 `cli/src/build/prescan/ios-appicon.ts` (NEW — AppIcon Contents.json reader)

```ts
interface AppIconImage { idiom?: string; size?: string; scale?: string; filename?: string; platform?: string; role?: string }
interface AssetContents { images?: AppIconImage[]; info?: { version?: number; author?: string } }
readContentsJson(path): AssetContents | null   // existsSync + readFileSync + JSON.parse in try/catch; null on missing/parse error (NEVER throws)
appIconSetDir(projectDir, pbxContent?): string  // join(projectDir,'ios','App','App','Assets.xcassets', `${iconName}.appiconset`)
                                                 // iconName = readBuildSetting(pbx,'ASSETCATALOG_COMPILER_APPICON_NAME') ?? 'AppIcon'
hasMarketingIcon(c): boolean                     // images.some(i => normalizeSize(i.size)==='1024x1024' || i.role==='marketing'); normalizeSize trims whitespace
```

### 1.6 `cli/src/build/prescan/capacitor-version.ts` (NEW — extract shared `capacitorMajor`)

Move the private `capacitorMajor(projectDir)` out of android-project.ts (L539-556) into
this shared module so the iOS deployment-target check reuses the exact
`@capacitor/core` ?? `@capacitor/ios` major detection. (Android currently reads
`@capacitor/core` ?? `@capacitor/android`; generalize to check core, ios, android.)
Re-import it back into android-project.ts to avoid duplication.

### 1.7 Reuse (no change)

`readTextIfExists` (gradle.ts L5) for Podfile/Podfile.lock/Package.swift/Package.resolved/
package.json text. `existsSync`/`readdirSync` for Pods/ & workspace presence.
`findSignableTargets`/`readPbxproj` (pbxproj-parser.ts). `capacitorPluginDeps` heuristic
(shared.ts L8-21) for optional plugin-pod cross-check. `parseProvisioningMap`/`hasMap`/
`bundleMatches` (ios-profiles.ts — export `bundleMatches`).

---

## 2. Final NEW iOS checks

Local = reads only project files. None of the new checks are `remote`. `appliesTo`
predicates are exact. Severity given as `error`/`warning`; "error-on-upload" means
`willUploadToAppStore(ctx) ? error : warning`.

All 33 checks in this expansion carry the hard-coded enforcement instant
`2026-08-14T00:00:00.000Z`. Before that instant, findings retain their real
severity and remain visible in terminal/JSON/telemetry, but are information-only
for outcome decisions. Critical output explicitly says that builds will fail
starting at the deadline. Existing prescan checks are not deferred.

### 2.A Info.plist / App Store (file: `checks/ios-plist-checks.ts`)

| id | sev | local | appliesTo (exact) | detection (algorithm/regex) | fix |
|----|-----|-------|-------------------|------------------------------|-----|
| `ios/plist-bundle-id-format` | error | local | iOS; Info.plist exists | `v=plistString(raw,'CFBundleIdentifier')`. null→error "missing". `r=resolvePlistValue(v,pbx)`. If `r` still starts `'$('`→skip. Validate `r` against `/^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/` (reverse-DNS ≥2 segments, no space/_/`*`). Fail→error naming `r`. | Set valid reverse-DNS PRODUCT_BUNDLE_IDENTIFIER (no spaces/underscores/wildcards). |
| `ios/plist-version-short-format` | error | local | iOS; Info.plist exists | `v=resolvePlistValue(plistString(raw,'CFBundleShortVersionString'),pbx)`. null→(SKIP — presence owned by infoplist-sanity, see §5). `'$('`→skip. Else validate `/^\d+(\.\d+){0,2}$/`. Fail→error with value (ITMS-90060). | Set MARKETING_VERSION to ≤3 dot-separated integers (e.g. 1.4.2). |
| `ios/plist-version-build-format` | error | local | iOS; Info.plist exists | `v=resolvePlistValue(plistString(raw,'CFBundleVersion'),pbx)`. null→SKIP. `'$('`→skip. Else `/^\d+(\.\d+){0,2}$/`. Fail→error. Do NOT require monotonic/ordering (needs ASC history). | Set CURRENT_PROJECT_VERSION numeric, ≤3 integers (e.g. 42 or 1.4.42). |
| `ios/plist-encryption-compliance` | warning | local | `willUploadToAppStore(ctx)` | `plistHasKey(raw,'ITSAppUsesNonExemptEncryption')===false` → warning. Do NOT assert which value is correct. | Add `ITSAppUsesNonExemptEncryption=<false/>` (most Capacitor apps) to stop the per-upload Missing Compliance prompt. |
| `ios/plist-ats-arbitrary-loads` | warning (→error on upload+dev-config) | local | iOS; Info.plist exists | `d=plistDictBlock(raw,'NSAppTransportSecurity')`; null→[]. If `plistBool(d,'NSAllowsArbitraryLoads')===true`→finding. Escalate to **error** when `willUploadToAppStore(ctx) && (ctx.config?.server?.cleartext===true \|\| ctx.config?.server?.url)`. | Remove NSAllowsArbitraryLoads (or `<false/>`); use scoped NSExceptionDomains; remove server.url/cleartext before release. |
| `ios/plist-launch-storyboard` | error | local | iOS; Info.plist exists | `ok = plistHasKey(raw,'UILaunchStoryboardName') \|\| plistHasKey(raw,'UILaunchScreen')`. !ok→error (ITMS-90475/90096). (Drop the optional storyboard-file-existence sub-check — higher FP, low value.) | Add `UILaunchStoryboardName=LaunchScreen` (Capacitor default) or a UILaunchScreen dict. |
| `ios/plist-orientations-multitasking` | warning | local | iOS; Info.plist exists; `TARGETED_DEVICE_FAMILY` (readBuildSetting) contains `2`; NOT `plistBool(raw,'UIRequiresFullScreen')===true` | `ipad = plistArrayStrings(raw,'UISupportedInterfaceOrientations~ipad')` (fallback to non-suffixed only if `~ipad` key entirely absent). Missing any of the four `UIInterfaceOrientation{Portrait,PortraitUpsideDown,LandscapeLeft,LandscapeRight}`→warning listing missing. SCOPE STRICTLY to `~ipad` (grounding iPhone array is missing PortraitUpsideDown → would FP). (ITMS-90474). | Add all four to `~ipad`, or add `UIRequiresFullScreen=<true/>`. |
| `ios/plist-orientations-present` | warning | local | iOS; Info.plist exists | `arr=plistArrayStrings(raw,'UISupportedInterfaceOrientations')`. Key absent OR zero entries→warning. Present-but-invalid token (not one of the four constants)→warning naming the bad token. | Declare ≥1 valid UIInterfaceOrientation* value. |
| `ios/plist-display-name` | warning | local | iOS; Info.plist exists | `disp=resolvePlistValue(plistString(raw,'CFBundleDisplayName'),pbx)`; `name=resolvePlistValue(plistString(raw,'CFBundleName'),pbx)`. Warning only if BOTH null/empty after resolution OR both still `'$('` with no pbx match. Grounding passes (literal CFBundleDisplayName). | Set CFBundleDisplayName or ensure PRODUCT_NAME resolves. |
| `ios/plist-background-modes-sanity` | warning | local | iOS; Info.plist has `UIBackgroundModes` | `modes=plistArrayStrings(raw,'UIBackgroundModes')`; empty→[]. (a) any token ∉ {audio,location,voip,fetch,remote-notification,processing,bluetooth-central,bluetooth-peripheral,external-accessory,newsstand-content}→warning (invalid mode). (b) `location` present but no `NSLocation*UsageDescription` key in plist→warning (2.5.4). Gate (b) to `willUploadToAppStore(ctx)`. Do NOT hard-error on audio/location presence. | Remove unused background modes; add matching usage strings/capabilities. |

Notes:
- `ios/plist-deployment-target` from research #1 is CUT (see §5): no real ASC
  deployment-target floor exists; the build-breaking floor is Capacitor's and is
  covered by `ios/xcode-deployment-target-capacitor` in §2.B.
- `ios/plist-bundle-id-vs-appid` from research #1 is CUT/folded (see §5): duplicates
  `shared/bundle-id-consistency`.
- `ios/plist-app-icon` from research #1 is CUT: superseded by the §2.F appicon checks
  (asset-catalog based, cleaner split).

### 2.B Xcode project / build settings (file: `checks/ios-xcode.ts`)

| id | sev | local | appliesTo (exact) | detection | fix |
|----|-----|-------|-------------------|-----------|-----|
| `ios/xcode-deployment-target-capacitor` | error | local | iOS; `capacitorMajor(projectDir)!==null`; `IPHONEOS_DEPLOYMENT_TARGET` PRESENT in app-target or project-level config | floor map `{5:13,6:13,7:14,8:14, default:14}` (extend android-style). Read target value via `readBuildSetting`/`readTargetConfigs` app (application product-type) target Release-pref + project-level. `parseFloat`. Flag PRESENT value `< floor`. Absent key OR null major→[]. Grounding 15.0/Cap8(floor14)→pass. | Raise IPHONEOS_DEPLOYMENT_TARGET to ≥floor (project + app target) and the Podfile platform line if present. |
| `ios/xcode-signing-team` | error-on-upload | local | iOS; some signable target has `CODE_SIGN_STYLE` PRESENT (Automatic or Manual) with `DEVELOPMENT_TEAM` absent/empty; AND `parseProvisioningMap(ctx).length===0` | **MERGED** Automatic+Manual no-team checks (research recommended). Per signable target Release-pref (fallback Debug): if CODE_SIGN_STYLE present (Automatic or Manual) AND DEVELOPMENT_TEAM absent/empty/`""`→finding. Suppress entirely when a provisioning map IS present (builder injects team+manual signing). Severity `error` when `willUploadToAppStore(ctx)` else `warning`. Grounding DEVELOPMENT_TEAM=UVTJ336J2D→pass. | Set DEVELOPMENT_TEAM in Xcode, or supply signing creds/profiles to the cloud build (map switches to managed-manual). |
| `ios/xcode-bundle-id-mismatch-across-configs` | warning | local | iOS; ≥1 signable target has `PRODUCT_BUNDLE_IDENTIFIER` PRESENT in ≥2 configs | Per signable target collect PRODUCT_BUNDLE_IDENTIFIER from every config in its configList (`readTargetConfigs`). If ≥2 PRESENT values differ→warning naming target + per-config values. Ignore absent (inherited). Single-config→skip. Grounding Debug==Release→pass. Distinct from shared/bundle-id-consistency (appId vs resolved) and targets-covered (profile coverage). | Align PRODUCT_BUNDLE_IDENTIFIER across Debug/Release (or ignore if Debug suffix is intentional). |
| `ios/xcode-enable-bitcode-leftover` | warning | local | iOS; `ENABLE_BITCODE` PRESENT with value `YES` anywhere (`readBuildConfigs`) | Read ENABLE_BITCODE from project + target configs. Flag any PRESENT `==YES` (aggregate which configs). Absent (modern default)→[]. Grounding absent→pass. | Set ENABLE_BITCODE=NO or delete it (deprecated since Xcode 14). |
| `ios/xcode-swift-version-sanity` | warning | local | iOS; signable target has `SWIFT_VERSION` PRESENT | Per signable target parse leading numeric of SWIFT_VERSION. Flag PRESENT and (`<5` OR not a number). Absent→skip (Obj-C-only target). Grounding 5.0→pass. | Set SWIFT_VERSION=5.0 (or intended ≥5). |
| `ios/xcode-no-app-target` | error | local | iOS; `readPbxproj(projectDir)!==null` | `findSignableTargets`; count `productType==='com.apple.product-type.application'`. If pbxproj non-null but count===0→error. readPbxproj null→skip (project-missing owned elsewhere). Grounding 1 app target→pass. | `npx cap sync ios` or restore the application target. |
| `ios/xcode-multiple-app-targets` | warning | local | iOS; `findSignableTargets` yields >1 application-product-type target | Filter `productType==='com.apple.product-type.application'`; `length>1`→warning listing names+bundle ids. Extensions don't count. Grounding 1→pass. | Keep a single app target; remove the duplicate or pass the intended scheme. |

Notes:
- `ios/xcode-automatic-signing-no-team` + `ios/xcode-manual-signing-no-team`
  (research #2) MERGED into `ios/xcode-signing-team`.

### 2.C Entitlements / capabilities (file: `checks/ios-entitlements-checks.ts`)

| id | sev | local | appliesTo (exact) | detection | fix |
|----|-----|-------|-------------------|-----------|-----|
| `ios/entitlements-vs-profile-capability` | error | local | primary app profile exists AND `readAppEntitlements(projectDir)!==null` | Resolve the app target's `CODE_SIGN_ENTITLEMENTS` path (fall back to `ios/App/App/App.entitlements` only when absent), then compare only with the provisioning-map entry matching `ctx.appId`; extension/watch profiles are excluded. Parse `profileEntitlements` generically (every key in the profile Entitlements dict, by sibling value tag string/bool/array). Build app capability-key set excluding `aps-environment`, `get-task-allow`, `application-identifier`, `*.team-identifier` (auto-managed). For each app key, profile must grant it: bool/string→same key present; array keys → every app member ⊆ profile list, but a wildcard member covers all. | Enable the capability for this App ID in the portal, regenerate the profile, re-save creds; or remove the unused entitlement. |
| `ios/entitlements-aps-environment-vs-mode` | warning/**error** | local | `readAppEntitlements` has `aps-environment` AND `ctx.distributionMode` set | `v=entString(raw,'aps-environment')`. `distributionMode==='app_store' && v==='development'`→**warning** by default (the default Capacitor leftover is benign on a push-free app and the cloud builder neither rewrites entitlements nor fails the archive on it), escalating to **error** only with independent push evidence (Info.plist `UIBackgroundModes` contains `remote-notification`). `distributionMode==='ad_hoc' && v==='production'`→**warning** (ad_hoc may use prod APNs). If `hasMap`: cross-check profile `aps-environment`; app≠profile→**error** (a mapped profile granting `production` while the app declares `development` is a real signing mismatch). Grounding (development, no mode→appliesTo false unless mode set; with app_store→**warning**, NOT a build-blocking error — restores the clean-scan baseline). | Set aps-environment=production for App Store/TestFlight push, or remove aps-environment if the app does not use push. |
| `ios/entitlements-associated-domains-format` | warning | local | `readAppEntitlements` has non-empty `com.apple.developer.associated-domains` | Per `<string>`: require `/^(applinks\|webcredentials\|activitycontinuation\|appclips):[a-z0-9.-]+(\?mode=(developer\|managed))?$/i`. Flag entries containing `://`, starting `http`, containing `/`, containing spaces, or unknown service prefix. Don't flag the `service:*` managed-wildcard form. | Use `service:domain` (e.g. `applinks:example.com`) — no scheme/path/trailing slash. |
| `ios/entitlements-app-groups-format` | warning | local | `readAppEntitlements` has non-empty `com.apple.security.application-groups` | Per `<string>`: warn if it does not start with `group.`, or contains uppercase/whitespace/illegal chars. Pure format (subset coverage handled by entitlements-vs-profile). | Rename to `group.<reverse-dns>` and register in the portal. |

### 2.D Capacitor config (file: `checks/ios-capacitor-config.ts`)

| id | sev | local | appliesTo (exact) | detection | fix |
|----|-----|-------|-------------------|-----------|-----|
| `ios/capacitor-server-url-shipped` | error (→warning if not uploading) | local | iOS; `typeof ctx.config?.server?.url === 'string' && server.url !== ''` | Non-empty server.url→finding. Detail escalates when dev target: `http://` (non-https), RFC1918 IP (`10.`/`172.(1[6-9]\|2\d\|3[01]).`/`192.168.`), `localhost`/`127.0.0.1`, or tunnel host (`*.ngrok.io`/`*.trycloudflare.com`/`*.loca.lt`). Severity `error` when `willUploadToAppStore(ctx)` else `warning` (research note: optionally always-error; we gate hard error to upload to limit dev-scan noise). | Remove server.url live-reload block before production; build web assets + `npx cap sync`. |
| `ios/capacitor-server-cleartext` | warning (→error w/ http url) | local | iOS; `ctx.config?.server?.cleartext === true` | `cleartext===true`→warning. Escalate to **error** when `server.url` present AND starts `http://`. | Remove/`false` server.cleartext for production; use https or a scoped ATS exception. |
| `ios/capacitor-allow-navigation-wildcard` | warning | local | iOS; `Array.isArray(ctx.config?.server?.allowNavigation)` and it contains a wildcard-only/public-suffix-wildcard entry | For each entry flag `*` and `*.<publicsuffix>` (e.g. `*.com`,`*.io`) with no specific host. Do NOT flag `*.example.com` or concrete hosts. One finding listing offenders. | Restrict allowNavigation to specific hosts; remove blanket `*`. |

### 2.E Pods / SPM (file: `checks/ios-pods-assets.ts`)

Layout discriminator up front: CocoaPods = `readTextIfExists(ios/App/Podfile)!==null`;
SPM = `readTextIfExists(ios/App/CapApp-SPM/Package.swift)!==null`. Pods checks
early-return when no Podfile; SPM checks early-return when no Package.swift.
Grounding is SPM-only → all Pods checks early-return.

| id | sev | local | appliesTo (exact) | detection | fix |
|----|-----|-------|-------------------|-----------|-----|
| `ios/pods-not-installed` | warning | local | iOS; `ios/App/Podfile` exists | `podsDir=existsSync(ios/App/Pods)`; `ws=existsSync(ios/App/App.xcworkspace)`. `!podsDir \|\| !ws`→warning (distinguish the two sub-cases in detail). Do NOT fire when Podfile absent (SPM; cap-sync-stale owns missing-Podfile). | `npx cap sync ios` (or `pod install`); commit Pods/ + App.xcworkspace. |
| `ios/pods-lock-missing` | warning | local | iOS; `ios/App/Podfile` exists | `readTextIfExists(ios/App/Podfile.lock)===null`→warning. Separate from pods-not-installed. | `pod install`; commit Podfile.lock. |
| `ios/pods-capacitor-missing` | error | local | iOS; `ios/App/Podfile` exists | Podfile text NOT matching `/pod\s+['"]Capacitor['"]/`→error (core not wired). Optional lower-confidence detail: plugins from `capacitorPluginDeps` whose PascalCase pod (`@capacitor/camera`→`CapacitorCamera`) is absent from the Podfile — keep as DETAIL only (community plugins have non-standard pod names). | `npx cap sync ios` then `pod install`. |
| `ios/spm-package-resolved-missing` | error | local | iOS; `ios/App/CapApp-SPM/Package.swift` exists | Neither `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` NOR `ios/App/CapApp-SPM/Package.resolved` exists→error. Grounding has the xcodeproj one→pass. | `xcodebuild -resolvePackageDependencies` or open in Xcode; commit Package.resolved. |
| `ios/spm-capacitor-dependency-missing` | error | local | iOS; `ios/App/CapApp-SPM/Package.swift` exists | Package.swift text NOT matching `/capacitor-swift-pm/` OR NOT matching `/\.product\(name:\s*['"]Capacitor['"]/`→error. (File header "DO NOT MODIFY ... managed by Capacitor CLI" → stable to regex.) Grounding matches both→pass. | `npx cap sync ios` to regenerate Package.swift. |

### 2.F App icons / assets (file: `checks/ios-pods-assets.ts`)

Merges research #1 `ios/plist-app-icon` and research #4's three appicon checks into a
clean 3-way split. `readContentsJson` (§1.5) is the shared parse-safety net.

| id | sev | local | appliesTo (exact) | detection | fix |
|----|-----|-------|-------------------|-----------|-----|
| `ios/appicon-empty-or-placeholder` | error | local | iOS (always) | `dir=appIconSetDir(...)`. `!existsSync(dir)`→error "AppIcon.appiconset missing". Else `c=readContentsJson(dir/Contents.json)`: null→error "missing or malformed". Else `(c.images??[]).filter(i=>i.filename?.trim()).length===0`→error "no icon images". Distinct from marketing-missing (fires regardless of upload). Grounding 1 image→pass. | `npx @capacitor/assets generate` (or Xcode) so the set has ≥ the 1024 icon. |
| `ios/appicon-referenced-file-missing` | error | local | iOS; AppIcon.appiconset/Contents.json exists & parses | For every image entry with non-empty `filename`: `existsSync(join(dir,filename))`. Any missing→error listing missing filenames. Grounding file present→pass. | Regenerate icons or commit the referenced PNG(s). |
| `ios/appicon-marketing-missing` | error | local | `willUploadToAppStore(ctx)` | `c=readContentsJson(...)`; if `!hasMarketingIcon(c)` (no `1024x1024` size and no `role==='marketing'`)→error (ITMS-90704). Upload-gated (ad_hoc/dev don't need the store icon). Grounding has 1024→pass. | Add a 1024x1024 PNG (no alpha) marketing icon; reference it in Contents.json. |

Note: research #4 `ios/deployment-target-consistency` (SPM `.iOS(.vN)` vs pbxproj)
is included as ONE additional check (below) — it is SPM-specific and distinct from
the Capacitor-floor check in §2.B.

| id | sev | local | appliesTo (exact) | detection | fix |
|----|-----|-------|-------------------|-----------|-----|
| `ios/spm-deployment-target-consistency` | warning | local | iOS; `ios/App/CapApp-SPM/Package.swift` exists AND `IPHONEOS_DEPLOYMENT_TARGET` PRESENT | `pbxTarget`=parseFloat(readBuildSetting IPHONEOS_DEPLOYMENT_TARGET, app-target Release-pref). `spmMin`=`/\.iOS\(\.v(\d+)\)/` from Package.swift. Warn when `pbxTarget < spmMin` (the dangerous direction — Package requires higher than the app builds against). Numeric major.minor compare. Grounding 15.0 vs .v15→pass. | Raise IPHONEOS_DEPLOYMENT_TARGET to ≥ Package.swift min, or `npx cap sync ios`. |

---

## 3. appliesTo gating summary

| Gate | Checks |
|------|--------|
| `willUploadToAppStore(ctx)` (upload-gated) | `ios/plist-encryption-compliance`, `ios/appicon-marketing-missing`, `ios/plist-background-modes-sanity` (location-2.5.4 sub-check only) |
| upload escalates severity (warn→error) | `ios/xcode-signing-team`, `ios/capacitor-server-url-shipped`, `ios/plist-ats-arbitrary-loads` |
| `ctx.distributionMode` required | `ios/entitlements-aps-environment-vs-mode` |
| `hasMap(ctx)` (provisioning map present) | `ios/entitlements-vs-profile-capability`; suppresses `ios/xcode-signing-team` |
| File-presence | All Info.plist checks (Info.plist exists); Pods checks (Podfile exists); SPM checks (Package.swift exists); entitlements checks (App.entitlements exists); appicon empty/referenced (always; degrade in run); `ios/xcode-no-app-target` (readPbxproj non-null) |
| Build-setting presence (skip if absent/inherited) | deployment-target, signing-team, bitcode, swift-version, bundle-id-across-configs, spm-deployment-consistency |
| Always (iOS, degrade in run) | `ios/appicon-empty-or-placeholder` |

---

## 4. File / registry plan

New files under `cli/src/build/prescan/`:

Parsing helpers:
- `checks/ios-plist-read.ts` — plistString/Bool/HasKey/ArrayStrings/DictBlock
- `ios-buildsettings.ts` — readBuildSetting + resolvePlistValue
- `ios-pbxsettings.ts` — readBuildConfigs + readTargetConfigs (or fold into ios-buildsettings)
- `ios-entitlements.ts` — readAppEntitlements + ent* readers; + MobileprovisionDetail.profileEntitlements extension (edit mobileprovision-parser.ts)
- `ios-appicon.ts` — readContentsJson + appIconSetDir + hasMarketingIcon
- `capacitor-version.ts` — shared capacitorMajor (extracted from android-project.ts)

Check modules:
- `checks/ios-plist-checks.ts` — 10 checks (§2.A)
- `checks/ios-xcode.ts` — 7 checks (§2.B)
- `checks/ios-entitlements-checks.ts` — 4 checks (§2.C)
- `checks/ios-capacitor-config.ts` — 3 checks (§2.D)
- `checks/ios-pods-assets.ts` — 9 checks (§2.E-F, incl. spm-deployment-consistency)

`registry.ts` changes: import each exported check and append to `ALL_CHECKS` under
new grouping comments (`// ios info.plist / app store`, `// ios xcode project`,
`// ios entitlements / capabilities`, `// ios capacitor config`, `// ios pods/spm`,
`// ios app icons`). Also re-point android-project.ts to import `capacitorMajor`
from `../capacitor-version`.

### Check count

- Current iOS checks: 10 (p12-opens, p12-expiry, asc-key-valid, asc-key-access,
  profile-expiry, profile-bundle-match, profile-type-vs-mode, cert-profile-pairing,
  targets-covered, infoplist-sanity). Plus shared/* that also run on iOS.
- NEW iOS checks: **33**
  - Info.plist / App Store: 10
  - Xcode project: 7
  - Entitlements/capabilities: 4
  - Capacitor config: 3
  - Pods/SPM: 5
  - App icons/assets: 4 (incl. spm-deployment-consistency)
- **Total iOS after expansion: 43.**

(33 exceeds the 18-28 target; if trimming is desired, the lowest-value
high-FP/cosmetic 6-8 are flagged in §6 as "optional trims" — cutting those lands
at ~26-28. Recommended baseline ships all 33: each is grounded, low/medium FP, and
the grounding project scans clean.)

---

## 5. Cut list (researched → rejected, with reason)

| Rejected check (source) | Reason |
|--------------------------|--------|
| `ios/plist-bundle-id-vs-appid` (#1) | Duplicates `shared/bundle-id-consistency` (appId vs resolved bundle id). Instead: EXTEND shared/bundle-id-consistency to escalate to error when `willUploadToAppStore(ctx)` (ASC record match becomes load-bearing). No new check. |
| `ios/plist-deployment-target` (#1) | No real App-Store deployment-target floor exists (Apple's mandate is the build SDK, controlled by the cloud builder). The build-breaking floor is Capacitor's → covered by `ios/xcode-deployment-target-capacitor`. |
| `ios/plist-app-icon` (#1) | Superseded by the §2.F asset-catalog appicon checks (cleaner 3-way split: empty / referenced-missing / marketing-missing). |
| `ios/xcode-automatic-signing-no-team` + `ios/xcode-manual-signing-no-team` (#2) | MERGED into one `ios/xcode-signing-team` (fires for either style when DEVELOPMENT_TEAM missing + no map). Two near-identical checks collapse. |
| `ios/entitlements-icloud-container-coverage` (#3) | Folded into `ios/entitlements-vs-profile-capability` (iCloud keys are just more capability keys; the array-subset logic is identical). The general check's message names the specific key, so the sharper-message rationale is met without a second check. |
| `shared/cap-sync-stale` "Podfile missing" overlap | Existing `shared/cap-sync-stale` already flags missing Podfile on iOS. `ios/pods-not-installed` is scoped to *Podfile-present-but-Pods/-or-workspace-missing* and explicitly does NOT fire when Podfile is absent — no overlap. |
| Any check requiring the built IPA / actool output / binary inspection | Out of static-scan scope (prescan runs pre-build on source). |
| Any "is the app actually using background audio/location" runtime judgement | Out of scope — only structural/invalid-token + missing-usage-string heuristics kept (in `ios/plist-background-modes-sanity`). |
| CFBundleIconName plist-key check | Injected at build time, correctly absent from Capacitor Info.plist → would FP on every healthy app. Asset-catalog detection used instead. |
| Monotonic/increasing CFBundleVersion check | Needs ASC build history (remote/stateful) — out of static scope; format-only kept. |

### Existing checks to lightly extend (not new modules)

- `shared/bundle-id-consistency`: add upload-aware severity escalation (warn→error
  when `willUploadToAppStore(ctx)`), absorbing the intent of `ios/plist-bundle-id-vs-appid`.
- `ios/infoplist-sanity`: have the presence-only CFBundleShortVersionString /
  CFBundleVersion warnings DEFER to the new format checks (or drop the presence
  warnings there) so the missing case is reported once, by the stronger check. See
  §2.A "null→SKIP" notes — the new format checks intentionally skip the null case to
  avoid double-reporting; if infoplist-sanity's presence warnings are removed instead,
  flip the format checks to own the null→warning case. Pick ONE owner; spec default:
  infoplist-sanity keeps presence, format checks skip null.

---

## 6. Optional trims (to land at 18-28 if mandated)

Lowest value / highest FP, in trim order (cut top-down):
1. `ios/plist-background-modes-sanity` (high FP, research-flagged).
2. `ios/plist-iphoneos-required` (cosmetic structural sanity; Capacitor always sets it).
3. `ios/plist-display-name` (cosmetic; grounding passes via literal).
4. `ios/xcode-multiple-app-targets` (rare; bad-merge only).
5. `ios/entitlements-app-groups-format` (format-only; rare in Capacitor apps).
6. `ios/capacitor-allow-navigation-wildcard` (security smell, not build-breaking).
7. `ios/spm-deployment-target-consistency` (warning-only; pbxproj≥spm usually fine).
8. `ios/plist-orientations-present` (Apple lenient on iPhone orientations).

Cutting 1-8 → 25 iOS checks (within target). Recommended: ship all 33 (each grounded,
clean against the real project).

---

## 7. TDD acceptance fixtures

1. **Healthy SPM project** (the grounding tutorial-app): every new check returns `[]`.
   This is the primary regression fixture — copy the real files into a test fixture dir.
2. **Per-check failing fixture**: minimal mutation of the healthy fixture (e.g.
   `CFBundleShortVersionString` literal `1.0-beta`; `aps-environment` + `distributionMode=app_store`;
   delete `AppIcon-512@2x.png`; `server.url` set; `IPHONEOS_DEPLOYMENT_TARGET=12.0` for Cap8).
3. **Unresolved-var fixture**: Info.plist `$()` refs with NO matching pbxproj setting →
   value-format checks must SKIP (no finding), proving the resolvePlistValue guard.
4. **Non-Capacitor / partial project**: missing Info.plist/pbxproj/appiconset → all
   checks early-return `[]` (no crashes).
