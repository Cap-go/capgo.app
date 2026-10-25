# Web2App app template

Native iOS and Android shell used by the Capgo **Web2App** plan, which turns a customer's static website into a store app.

The app is a Capacitor 8 project with `@capgo/capacitor-updater` in **website mode**:

- `www/index.html` is a small offline/loading page. It is the built-in bundle and has no external assets.
- When the app launches or resumes, the plugin calls `GET https://plugin.capgo.app/website_live?app_id=<appId>`. Allowed responses are `{ allowed: true, mode: 'website', website_url, check_interval_seconds }`. Denied responses omit `website_url` and may include an optional `reason` (`full_capgo`, `need_plan_upgrade`, or `missing_website_url`) plus `check_interval_seconds` when the app stays in website mode.
- If the website is allowed, the plugin downloads the entry HTML and the same-origin assets of `website_url` into a local bundle and applies it right away. Capgo does not host any bundle bytes.
- The customer website must call `CapacitorUpdater.notifyAppReady()` within `appReadyTimeout`. Otherwise the plugin rolls back and skips that website version for 24 hours.

Plugin config (`capacitor.config.ts`, `plugins.CapacitorUpdater`):

| key | value |
| --- | --- |
| `appId` | bundle id placeholder, sent as `app_id` to `/website_live` |
| `websiteMode` | `true` |
| `autoUpdate` | `true` (website mode needs it) |

The website URL is not in the config. The backend returns it.

> TODO: website mode ships in `@capgo/capacitor-updater` **8.53.0** ([Cap-go/capacitor-updater#946](https://github.com/Cap-go/capacitor-updater/pull/946)). The template is pinned to 8.52.1, the latest published version, which ignores `websiteMode`. Bump to `>= 8.53.0` once it is released, then run `bunx cap sync` and repack.

## Layout

The Capgo native builder runs Fastlane directly on the uploaded project. It does **not** run `bun install`, a web build or `cap sync`. Because of that, everything `cap sync` generates is committed:

- `ios/App/App/capacitor.config.json`, `ios/App/App/config.xml`
- `android/app/src/main/assets/capacitor.config.json`, `capacitor.plugins.json`
- `ios/capacitor-cordova-ios-plugins/`

The native `.gitignore` files were edited so these paths stay tracked.

The web assets copied into `ios/App/App/public/` and `android/app/src/main/assets/public/` and the `android/capacitor-cordova-android-plugins/` module are not committed (they are generated and still ignored): run `bunx cap sync` before packing, as the publish workflow does. The pack script fails if they are missing.

- iOS uses Swift Package Manager (`ios/App/CapApp-SPM`). There is no CocoaPods.
- Android `namespace` is fixed to `app.capgo.websitelive` (`MainActivity` lives in that package). Only `applicationId` changes per customer.
- Versions: `MARKETING_VERSION` / `versionName` are `1.0.0`. `CURRENT_PROJECT_VERSION` / `versionCode` are `1`.
- `ITSAppUsesNonExemptEncryption = false` is set in `Info.plist`, so App Store Connect does not ask the export compliance question.
- Icons:
  - iOS uses a single 1024x1024 universal icon, `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
  - Android uses only `mipmap-xxxhdpi/ic_launcher.png` (192), `ic_launcher_round.png` (192) and `ic_launcher_foreground.png` (432), plus the adaptive icons in `mipmap-anydpi-v26/`. The adaptive background color is `@color/ic_launcher_background` in `values/ic_launcher_background.xml`.

## Placeholders patched by the server

| placeholder | value | where |
| --- | --- | --- |
| bundle id | `app.capgo.websitelive.template` | `applicationId`, `PRODUCT_BUNDLE_IDENTIFIER`, `strings.xml` (`package_name`, `custom_url_scheme`), every `capacitor.config.*` (`appId` and `plugins.CapacitorUpdater.appId`) |
| app name | `Web2App Template` | `CFBundleDisplayName`, `strings.xml` (`app_name`, `title_activity_main`), `capacitor.config.*` `appName`, fallback page `<title>` |
| website URL | `https://example.com` | fallback page `<meta name="capgo-website-url">` (informational only; the runtime URL comes from `/website_live`) |

The server reads `manifest.json` at the zip root and then:

1. Replaces each placeholder string in every file listed in `textFilesWithPlaceholders` (`placeholderFiles` gives the list per placeholder). Each placeholder is a plain string. Do not touch the Android `namespace` (`app.capgo.websitelive`). It is a prefix of the bundle id placeholder, so replace only the full placeholder string.
2. Overwrites `iosIconPath` with a 1024x1024 PNG that has no alpha channel. Overwrites `androidIconPaths.launcher` and `launcherRound` (192x192) and `launcherForeground` (432x432, safe zone 264). Sets the color in `androidIconPaths.backgroundColor`.
3. Zips the result again and sends it to the native builder.

## Updating the template

From `templates/website-live-app/`:

```sh
bun update @capacitor/core @capacitor/ios @capacitor/android @capacitor/cli @capgo/capacitor-updater
bunx cap sync
```

Then check that `cap sync` did not undo the template-specific edits (`git diff`):

- the `namespace` in `android/app/build.gradle`
- `MainActivity` in `app/capgo/websitelive/`
- the versions
- `ITSAppUsesNonExemptEncryption`
- the icon set
- the native `.gitignore` edits

For a Capacitor major upgrade, it is easier to delete `ios/` and `android/`, run `bunx cap add ios && bunx cap add android`, and then apply those edits again.

Optional local verification:

```sh
(cd android && ./gradlew assembleDebug)
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

## Packing

```sh
# From templates/website-live-app/
bunx cap sync

# From the repo root/
bun scripts/pack-website-live-template.ts            # -> dist/website-live-template.zip
```

The zip uses the same layout as `capgo build request` (see `cli/src/build/request.ts`), except that it contains both platforms:

- `package.json`, `bun.lock`, `capacitor.config.ts`, and a resolved `capacitor.config.json`
- `ios/` and `android/`, without build outputs, `.gradle`, `Pods`, `DerivedData`, `xcuserdata` or `local.properties`
- the native folders of the plugins referenced by `CapApp-SPM/Package.swift` and `capacitor.settings.gradle`: `@capacitor/ios`, `@capacitor/android`, `@capgo/capacitor-updater`
- `manifest.json`
