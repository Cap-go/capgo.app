// src/init/mcp/explanations.ts

const FALLBACK = [
  'This step is part of connecting your Capacitor app to Capgo for over-the-air updates.',
  'If you tell me which part is unclear, I can explain it in more detail.',
].join(' ')

const EXPLANATIONS: Record<string, string> = {
  'no-capacitor-project': 'WHAT: We could not find a Capacitor app in this folder.\nWHY: Capgo OTA onboarding needs a Capacitor project with an app id in capacitor.config.\nWHAT TO DO: Run this from your app directory, or run `npx cap init` first, then start again.',
  'login-required': 'WHAT: You need to be logged into Capgo before we can register your app and upload bundles.\nWHY: Capgo stores apps and channels against your account.\nWHAT TO DO: Run `npx @capgo/cli@latest login` in your terminal. Do not paste your API key into chat.',
  'resume-prompt': 'WHAT: A previous OTA onboarding session was saved for this project.\nWHY: Resuming keeps completed steps; restarting wipes saved progress and begins fresh.\nOPTIONS: "continue" picks up where you left off; "restart" clears saved progress.\nWHAT TO DO: Pick "continue" unless the saved state is wrong.',
  'add-app': 'WHAT: Register this app id in your Capgo account.\nWHY: Capgo needs an app record before channels and bundles can be created.\nWHAT TO DO: Wait — this step runs automatically once you are logged in.',
  'add-channel': 'WHAT: Create the default release channel (usually "production").\nWHY: Channels control which devices receive which OTA bundles.\nWHAT TO DO: Wait — this step runs automatically.',
  'install-updater': 'WHAT: Install @capgo/capacitor-updater and configure capacitor.config for Capgo.\nWHY: The native app needs the updater plugin to download and apply OTA bundles.\nWHAT TO DO: Wait — this step runs automatically.',
  'add-integration-code': 'WHAT: Add CapacitorUpdater.notifyAppReady() to your app entry file.\nWHY: Without this call the plugin cannot confirm the bundle started correctly.\nWHAT TO DO: Wait — this step runs automatically.',
  'setup-encryption': 'WHAT: Choose whether to enable end-to-end bundle encryption.\nWHY: Encryption protects bundle contents in transit and at rest on Capgo.\nOPTIONS: "enable" generates keys and encrypts uploads; "skip" uses standard signing only.\nWHAT TO DO: Pick based on whether your app handles sensitive data.',
  'select-platform': 'WHAT: Choose iOS or Android for the guided device validation.\nWHY: Native build and run commands differ per platform.\nOPTIONS: "ios" or "android".\nWHAT TO DO: Pick the platform you can run on a device or simulator now.',
  'build-project': 'WHAT: Build web assets and sync them into the native project.\nWHY: The device needs a baseline native build before we can test OTA.\nWHAT TO DO: Wait — this step runs automatically.',
  'run-on-device': 'WHAT: Launch the app on a real device or simulator.\nWHY: OTA updates apply inside a running native shell — we need the baseline app installed first.\nWHAT TO DO: Run the command shown, confirm the app opens, then continue.',
  'make-test-change': 'WHAT: Apply a visible test change and bump the OTA version.\nWHY: We need a new bundle version to upload and verify the update path.\nWHAT TO DO: Wait — this step runs automatically after git is clean (or you chose to continue with a dirty repo).',
  'dirty-git': 'WHAT: Your git working tree has uncommitted changes.\nWHY: The test change step edits project files; a dirty repo makes rollback harder.\nOPTIONS: "check-again" after you commit or stash; "continue-dirty" proceeds anyway (not recommended).\nWHAT TO DO: Commit or stash changes, then check again.',
  'upload-bundle': 'WHAT: Upload the new web bundle to Capgo on your channel.\nWHY: Devices poll Capgo for bundles linked to their channel.\nWHAT TO DO: Wait — this step runs automatically. If upload fails in a monorepo, retry with the monorepo root package.json and the monorepo root node_modules paths (not the app package folder).',
  'test-update': 'WHAT: Confirm the device received and applied the OTA update.\nWHY: This validates the full live-update path end to end.\nWHAT TO DO: Relaunch or background/foreground the app, look for the test banner or change, then confirm.',
  'completion': 'WHAT: OTA onboarding is complete.\nWHY: Your app is registered, the updater is wired, and a test update succeeded.\nWHAT TO DO: Use `npx @capgo/cli@latest bundle upload` for future releases on your channel.',
}

export function explainForState(state: string): string {
  return EXPLANATIONS[state] ?? FALLBACK
}
