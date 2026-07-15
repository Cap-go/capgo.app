# @capgo/react-native-updater

Capgo live updates for React Native. Uses the same Capgo Cloud backend and **file-level delta** system as `@capgo/capacitor-updater` (per-file SHA-256 manifests + optional Brotli), not binary bspatch.

## Install

```bash
npm install @capgo/react-native-updater
cd ios && pod install
```

## Native wiring

### Android

In `MainApplication`, override `getJSBundleFile()`:

```kotlin
override fun getJSBundleFile(): String {
  return CapgoUpdater.getJSBundleFile(applicationContext)
}
```

Add meta-data in `AndroidManifest.xml`:

```xml
<meta-data android:name="CapgoAppId" android:value="com.example.app" />
<meta-data android:name="CapgoUpdateUrl" android:value="https://plugin.capgo.app/updates" />
<meta-data android:name="CapgoStatsUrl" android:value="https://plugin.capgo.app/stats" />
```

### iOS

In `AppDelegate`, return Capgo's bundle URL in release:

```swift
#if !DEBUG
return CapgoUpdater.getJSBundleURL()
#endif
```

Add `CapgoAppId`, `CapgoUpdateUrl`, and `CapgoStatsUrl` to `Info.plist`.

## JS usage

```ts
import CapgoUpdater from '@capgo/react-native-updater'

await CapgoUpdater.notifyAppReady()

const latest = await CapgoUpdater.getLatest()
if (latest.url || latest.manifest?.length) {
  const bundle = await CapgoUpdater.download({
    url: latest.url ?? 'https://404.capgo.app/no.zip',
    version: latest.version,
    sessionKey: latest.sessionKey,
    checksum: latest.checksum ?? undefined,
    manifest: latest.manifest,
  })
  await CapgoUpdater.set({ id: bundle.id })
}
```

## Upload with CLI

```bash
npx @capgo/rn-cli@latest upload appId --channel production
```

This runs Metro, exports `index.android.bundle` + `main.jsbundle` + assets, then uploads with Capgo `--delta`.
