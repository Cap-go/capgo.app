import type { CapacitorConfig } from '@capacitor/cli'

// Capgo Web2App template. The Capgo server patches appId, appName and
// plugins.CapacitorUpdater.appId before the native build (see README.md).
// The website URL is not configured here: in website mode the plugin calls
// GET https://plugin.capgo.app/website_live?app_id=<appId>, which returns website_url.
const config: CapacitorConfig = {
  appId: 'app.capgo.websitelive.template',
  appName: 'Web2App Template',
  webDir: 'www',
  plugins: {
    CapacitorUpdater: {
      appId: 'app.capgo.websitelive.template',
      // Website mode (Capgo Web2App plan), needs @capgo/capacitor-updater >= 8.53.0.
      websiteMode: true,
      // Website mode requires autoUpdate to stay enabled; new website versions apply immediately.
      autoUpdate: true,
    },
  },
}

export default config
