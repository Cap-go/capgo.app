# @capgo/capacitor-notifications

First-party Capgo native notification plugin for Capacitor apps.

It handles:

- iOS and Android push token registration with Capgo
- Foreground notification receive events
- Notification open tracking
- Badge count reads and writes
- Background data notification callbacks
- Silent Capgo live update checks through `@capgo/capacitor-updater`

## Setup

Install the plugin from npm with the Capgo updater peer dependency when you want silent live-update checks from push notifications.

```bash
npm install @capgo/capacitor-notifications @capgo/capacitor-updater
npx cap sync
```

For iOS silent/background notifications, enable the `remote-notification` background mode and forward remote notifications from `ios/App/App/AppDelegate.swift`:

```swift
import CapgoNotificationsPlugin // CocoaPods: import CapgoCapacitorNotifications

func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    CapgoNotificationsPlugin.didReceiveRemoteNotification(userInfo, fetchCompletionHandler: completionHandler)
}
```

The static entry point keeps pushes that arrive before the Capacitor bridge has loaded the plugin (cold background launch). Posting a `CapgoNotificationsRemoteNotification` `NotificationCenter` notification with `userInfo` and `completionHandler` still works, but pushes posted before the plugin loads are dropped.

Or let the Capgo CLI patch the app entrypoint:

```bash
npx @capgo/cli@latest notifications setup
```

On Android, keep app backup and data-extraction policy in the host app manifest. The plugin manifest only declares the Android push messaging service.

## Usage

```ts
import { CapgoNotifications } from '@capgo/capacitor-notifications'

await CapgoNotifications.configure({
  appId: 'com.example.app',
  autoUpdater: true,
  updateInstallMode: 'next',
})

await CapgoNotifications.register({
  externalId: 'customer-user-123',
  identityProof: '<server-minted-proof>',
  tags: ['paid'],
  attributes: { plan: 'team' },
  consent: true,
})

CapgoNotifications.addListener('notificationReceived', (notification) => {
  console.log('Received', notification)
})

CapgoNotifications.addListener('notificationOpened', (event) => {
  console.log('Opened', event)
})
```

Mint `identityProof` from your backend with `POST /notifications/recipients/proof` using your Capgo API key, then pass it to the app after your own user authentication succeeds.

## Silent Update Checks

When Capgo sends a silent notification with `capgoAction=update_check`, the native plugin calls the native update pipeline of `@capgo/capacitor-updater` (`triggerUpdateCheck`, updater 8.52 or newer). No JavaScript runs: the update works while the WebView is suspended or a preview bundle is loaded. The updater downloads the bundle for the device's own channel and installs it with its own `autoUpdate` / `directUpdate` policy. The outcome is added to the payload as `capgoNativeUpdateCheck` (`queued`, `already_running`, `unavailable`, `preview_session`, `failed`).

With an older updater the native call reports `unsupported` and the JavaScript layer falls back to `getLatest` + `download` + `next`/`set`.

Limits:

- iOS background pushes are best-effort and can be throttled by the OS.
- Android delivers the push to a killed app without starting an Activity, so no Capacitor bridge exists. Pass the messaging service as context (`CapgoNotificationsPlugin.sendRemoteMessage(this, message)`, done by the bundled service) and the plugin starts the updater's `HeadlessUpdateWorker`: it downloads the bundle and makes it current for the next launch. Updaters without this worker apply the update at the next launch instead.

## Versioning

The major version follows the Capacitor major it targets: `8.x.y` supports Capacitor 8.
