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

For iOS silent/background notifications, forward remote notifications from `ios/App/App/AppDelegate.swift`:

```swift
func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    NotificationCenter.default.post(name: Notification.Name("CapgoNotificationsRemoteNotification"), object: nil, userInfo: [
        "userInfo": userInfo,
        "completionHandler": completionHandler,
    ])
}
```

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

When Capgo sends a silent notification with `capgoAction=update_check`, this plugin asks `@capgo/capacitor-updater` for the latest bundle, downloads it, and either:

- queues it with `next`, so it installs on the next app restart/background cycle
- installs it with `set`, when configured by the Capgo app setting

iOS background pushes remain best-effort and can be throttled by the OS.
