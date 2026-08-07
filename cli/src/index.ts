import { exit } from 'node:process'
import { log } from '@clack/prompts'
import { InvalidArgumentError, Option, program } from 'commander'
import pack from '../package.json'
import { categorizeCliError } from './analytics/error-category'
import { applyCommandAnalyticsOptOut, applyRawCommandAnalyticsOptOut } from './analytics/opt-out'
import { enableSupabaseInstrumentation } from './analytics/supabase-perf'
import { setCurrentCliCommand } from './analytics/cli-headers'
import { extractCommandContext, flushAnalytics, trackCommandFailed, trackCommandInvoked, trackCommandSucceeded } from './analytics/track'
import { addApp } from './app/add'
import { debugApp } from './app/debug'
import { deleteApp } from './app/delete'
import { getInfo } from './app/info'
import { listApp } from './app/list'
import { setApp } from './app/set'
import { setSetting } from './app/setting'
import { clearCredentialsCommand, listCredentialsCommand, migrateCredentialsCommand, saveCredentialsCommand, updateCredentialsCommand } from './build/credentials-command'
import { manageCredentialsCommand } from './build/credentials-manage'
import { syncIosMarketingVersionCommand } from './build/ios-marketing-version'
import { lastOutputCommand } from './build/last-output-command'
import { checkBuildNeeded } from './build/needed'
import type { OnboardingBuilderOptions } from './build/onboarding/command'
import { onboardingBuilderCommand } from './build/onboarding/command'
import { prescanCommand } from './build/prescan/command'
import type { CreateAppleKeyOptions } from './build/onboarding/asc-key/command'
import { createAppleKeyCommand } from './build/onboarding/asc-key/command'
import { requestBuildCommand } from './build/request'
import { cleanupBundle } from './bundle/cleanup'
import { checkCompatibility } from './bundle/compatibility'
import { decryptZip } from './bundle/decrypt'
import { deleteBundle } from './bundle/delete'
import { encryptZip } from './bundle/encrypt'
import { listBundle } from './bundle/list'
import { printReleaseType } from './bundle/releaseType'
import { handleBundleUploadCommand } from './bundle/upload-command'
import { zipBundle } from './bundle/zip'
import { addChannel } from './channel/add'
import { currentBundle } from './channel/currentBundle'
import { deleteChannel } from './channel/delete'
import { listChannels } from './channel/list'
import { setChannel } from './channel/set'
import { getConfigWriteTarget, resolveCapacitorConfigTargetPath, setConfigWriteTarget } from './config'
import { generateDocs } from './docs'
import { defaultStarRepo } from './github'
import { starAllRepositoriesCommand, starRepositoryCommand } from './github-command'
import { initApp } from './init'
import { finishActiveCliReplay } from './init/replay'
import { createKey, deleteOldKey, saveKeyCommand } from './key'
import { login } from './login'
import { startMcpServer } from './mcp/server'
import { setupNotifications } from './notifications/setup'
import { addOrganization, deleteOrganization, listMembers, listOrganizations, setOrganization } from './organization'
import { capturePosthogException, getCommandPath, shouldCapturePosthogException } from './posthog'
import { getPreviewQr } from './preview/qr'
import { probe } from './probe'
import { testRunDeviceCommand } from './run/device'
import { getUserId } from './user/account'
import { formatError } from './utils'
import { normalizeAutoBumpInput } from './versionHelpers'

// Common option descriptions used across multiple commands
const optionDescriptions = {
  apikey: `API key to link to your account`,
  supaHost: `Custom Supabase host URL (for self-hosting or Capgo development)`,
  supaAnon: `Custom Supabase anon key (for self-hosting)`,
  packageJson: `Paths to package.json files for monorepos (comma-separated)`,
  nodeModules: `Paths to node_modules directories for monorepos (comma-separated)`,
  capacitorConfig: `Capacitor config source to update (useful with dynamic monorepo configs)`,
  verbose: `Enable verbose output with detailed logging`,
}

/** Collector for repeatable CLI options (e.g. --ios-provisioning-profile used multiple times) */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

program
  .name(pack.name)
  .description(`📦 Manage packages and bundle versions in Capgo Cloud`)
  .version(pack.version, '-v, --version', `output the current version`)
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)

// Turn on client-side Supabase perf tracking for the CLI. (Off by default so
// the SDK bundle, which transitively imports createSupabaseClient, stays clean.)
enableSupabaseInstrumentation()

let currentCommandPath = 'unknown'

program.hook('preAction', (_thisCommand, actionCommand) => {
  setConfigWriteTarget(resolveCapacitorConfigTargetPath(actionCommand.optsWithGlobals().capacitorConfig))
  currentCommandPath = getCommandPath(actionCommand)
  setCurrentCliCommand(currentCommandPath)
  applyCommandAnalyticsOptOut(currentCommandPath, actionCommand.opts())
  trackCommandInvoked(currentCommandPath, extractCommandContext(actionCommand))
})

program.hook('postAction', (_thisCommand, actionCommand) => {
  try {
    trackCommandSucceeded(getCommandPath(actionCommand))
  }
  finally {
    if (getCommandPath(actionCommand) !== 'mcp')
      setConfigWriteTarget()
  }
})

program
  .command('init [apikey] [appId]')
  .alias('i')
  .description(`🚀 Initialize a new app in Capgo Cloud with step-by-step guidance.

This includes adding code for updates, building, uploading your app, and verifying update functionality.
Capgo bundles are web assets and can be fetched by anyone who knows the URL. Use encryption for banking, regulated, or other high-security apps.
During the iOS run-on-device step, choose a physical iPhone/iPad or simulator. If you choose a physical device, the CLI lets you connect, unlock, and check again before it launches the app.

Example: npx @capgo/cli@latest init YOUR_API_KEY com.example.app`)
  .action(initApp)
  .option('-n, --name <name>', `App name for display in Capgo Cloud`)
  .option('-i, --icon <icon>', `App icon path for display in Capgo Cloud`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)
  .option('--package-json <path>', 'Package JSON for the Capacitor app to onboard (useful in monorepos)')
  .option('--main-file <path>', 'Application entry file to update (useful in monorepos)')
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)
  .option('--no-analytics', 'Disable init analytics and terminal replay for this run')

const run = program
  .command('run')
  .description(`📱 Run Capacitor apps on devices from the CLI.`)

run
  .command('device [platform]')
  .description(`📱 Run your Capacitor app on a connected device or simulator.

If you omit the platform in an interactive terminal, the command asks whether to start on iOS or Android.
The command lists available devices and simulators, lets you reload the list, and runs with your selection.
For iOS, this asks whether to use a physical iPhone/iPad or simulator before showing devices.
Use --no-launch to print the resolved command without starting the app.

Example: npx @capgo/cli@latest run device ios --no-launch`)
  .action(testRunDeviceCommand)
  .option('--no-launch', `Resolve and print the run command without starting the app`)

program
  .command('star [repository]')
  .description(`⭐ Star a Capgo GitHub repository to support the project.

If you do not pass a repository name, this defaults to ${defaultStarRepo} in the Cap-go org.`)
  .action(starRepositoryCommand)

program
  .command('star-all [repositories...]')
  .description(`⭐ Star all Capgo GitHub repositories with a small random delay between each request.

If you do not pass repositories, this defaults to all Cap-go repositories whose name starts with \`capacitor-\`.`)
  .option('--min-delay-ms <ms>', 'Minimum delay in ms between each star action (default: 20)')
  .option('--max-delay-ms <ms>', 'Maximum delay in ms between each star action (default: 180)')
  .option('--max-concurrency <count>', 'Maximum number of star requests running in parallel (default: 4)')
  .action(starAllRepositoriesCommand)

program
  .command('doctor')
  .description(`👨‍⚕️ Check if your Capgo app installation is up-to-date and gather information useful for bug reports.

This command helps diagnose issues with your setup.

Example: npx @capgo/cli@latest doctor`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)
  .action(async (...args) => {
    const options = args.at(-1)
    await getInfo(options)
  })

program
  .command('login [apikey]')
  .alias('l')
  .description(`🔑 Save your Capgo API key to your machine or local folder for easier access to Capgo Cloud services.

Use --apikey=******** in any command to override it.

Example: npx @capgo/cli@latest login YOUR_API_KEY`)
  .action(login)
  .option('--local', `Only save in local folder, git ignored for security.`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

program
  .command('get-qr [appId] [target]')
  .description(`🔳 Print a terminal QR code for a bundle or channel preview.

Preview must be enabled for the app.

Examples:
  npx @capgo/cli@latest get-qr com.example.app --bundle 1.2.3
  npx @capgo/cli@latest get-qr com.example.app --bundle 123
  npx @capgo/cli@latest get-qr com.example.app --channel production
  npx @capgo/cli@latest get-qr com.example.app production --type channel`)
  .action(getPreviewQr)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--bundle <bundle>', `Bundle name or id to preview`)
  .option('--channel <channel>', `Channel name or id to preview`)
  .addOption(new Option('--type <type>', `Type for positional target`).choices(['bundle', 'channel']))
  .option('--png <path>', `Write the preview QR code as a PNG image to the given file path`)
  .option('--url', `Print preview URLs only (web and deep link), without a terminal QR code`)
  .option('--web-url', `Encode the web preview URL in the QR code and PNG instead of the capgo:// deep link`)
  .addOption(new Option('--preview-env <env>', `Preview web URL environment`).choices(['prod', 'preprod', 'dev']).default('prod'))
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

const bundle = program
  .command('bundle')
  .description(`📦 Manage app bundles for deployment in Capgo Cloud, including upload, compatibility checks, and encryption.`)

bundle
  .command('upload [appId]')
  .alias('u')
  .description(`⬆️ Upload a new app bundle to Capgo Cloud for distribution.

Version must be > 0.0.0 and unique. Deleted versions cannot be reused for security.

External option: Store only a URL link (useful for apps >200MB or privacy requirements).
Capgo never inspects external content. Add encryption for trustless security.

Example: npx @capgo/cli@latest bundle upload com.example.app --path ./dist --channel production,beta`)
  .action(handleBundleUploadCommand)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-p, --path <path>', `Path of the folder to upload, if not provided it will use the webDir set in capacitor.config`)
  .option('-c, --channel <channel>', `Channel to link to. Use commas for multiple channels, for example production,beta`)
  .option('--rollout <rollout>', `Set the uploaded bundle as this channel's rollout target at a percentage from 0 to 100`, value => Number.parseFloat(value))
  .option('--rollout-percentage-bps <rolloutPercentageBps>', `Set the uploaded bundle rollout percentage in basis points from 0 to 10000`, value => Number.parseInt(value, 10))
  .option('--rollout-cache-ttl-seconds <rolloutCacheTtlSeconds>', `Cloudflare rollout decision cache TTL in seconds`, value => Number.parseInt(value, 10))
  .option('-e, --external <url>', `Link to external URL instead of upload to Capgo Cloud`)
  .option('--iv-session-key <key>', `Set the IV and session key for bundle URL external`)
  .option('--s3-region <region>', `Region for your S3 bucket`)
  .option('--s3-apikey <apikey>', `API key for your S3 endpoint`)
  .option('--s3-apisecret <apisecret>', `API secret for your S3 endpoint`)
  .option('--s3-endpoint <s3Endpoint>', `URL of S3 endpoint`)
  .option('--s3-bucket-name <bucketName>', `Name for your AWS S3 bucket`)
  .option('--s3-port <port>', `Port for your S3 endpoint`)
  .option('--no-s3-ssl', `Disable SSL for S3 upload`)
  .option('--key-v2 <key>', `Custom path for private signing key (v2 system)`)
  .option('--key-data-v2  <keyDataV2>', `Private signing key (v2 system)`)
  .option('--bundle-url', `Prints bundle URL into stdout`)
  .option('--no-key', `Ignore signing key and send clear update`)
  .option('--no-code-check', `Ignore checking if notifyAppReady() is called in source code and index present in root folder`)
  .option('--display-iv-session', `Show in the console the IV and session key used to encrypt the update`)
  .option('-b, --bundle <bundle>', `Bundle version number of the bundle to upload`)
  .option('--link <link>', `Link to external resource (e.g. GitHub release)`)
  .option('--comment <comment>', `Comment about this version, could be a release note, a commit hash, a commit message, etc.`)
  .option(
    '--min-update-version <minUpdateVersion>',
    `Minimal version required to update to this version. Used only if the disable auto update is set to metadata in channel`,
  )
  .option('--auto-min-update-version', `Set the min update version based on native packages`)
  .option('--ignore-metadata-check', `Ignores the metadata (node_modules) check when uploading`)
  .option('--fail-on-incompatible', `Fail the upload (exit non-zero) instead of uploading when the bundle is incompatible with the channel's current native packages. In an interactive terminal you can still choose a native build; declining fails. Cannot be combined with --ignore-metadata-check.`)
  .option('--ignore-checksum-check', `Ignores the checksum check when uploading`)
  .option('--force-crc32-checksum', `Force CRC32 checksum for upload (override auto-detection)`)
  .option('--timeout <timeout>', `Timeout for the upload process in seconds`)
  .option('--multipart', `[DEPRECATED] Use --tus instead. Uses multipart protocol for S3 uploads`)
  .option('--zip', `Upload the bundle using zip to Capgo cloud (legacy)`)
  .option('--tus', `Upload the bundle using TUS to Capgo cloud`)
  .option('--tus-chunk-size <tusChunkSize>', `Chunk size in bytes for TUS resumable uploads (default: auto)`)
  .option('--partial', `[DEPRECATED] Use --delta instead. Upload incremental updates`)
  .option('--partial-only', `[DEPRECATED] Use --delta-only instead. Upload only incremental updates, skip full bundle`)
  .option('--delta', `Upload delta updates (only changed files) for instant, super-fast updates instead of big zip downloads. Capgo refuses delta uploads over 10,000 files (delta tracks each file); use --no-delta for a full zip, or reduce files in your web build.`)
  .option('--delta-only', `Upload only delta updates without full bundle for maximum speed (useful for large apps)`)
  .option('--no-delta', `Disable delta updates even if instant updates are enabled`)
  .option('--encrypted-checksum <encryptedChecksum>', `An encrypted checksum (signature). Used only when uploading an external bundle.`)
  .option('--auto-set-bundle', `Set the bundle version in Capacitor config`)
  .addOption(new Option('--auto-bump [level]', `Auto-increment bundle version from the latest remote channel/app version. Level: major, minor (default), patch|fix, metadata (prerelease), or ai`)
    .preset('minor')
    .argParser((value: string) => {
      const level = normalizeAutoBumpInput(value)
      if (!level) {
        throw new InvalidArgumentError(`Invalid --auto-bump level "${value}". Allowed: major, minor, patch, fix, metadata, ai.`)
      }
      return level
    }))
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)
  .option('--dry-upload', `Dry upload the bundle process: add the row in database without uploading files or updating channels (Used by Capgo for internal testing)`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)
  .option('--node-modules <nodeModules>', optionDescriptions.nodeModules)
  .option('--encrypt-partial', `Encrypt delta update files (auto-enabled for updater > 6.14.4)`)
  .option('--delete-linked-bundle-on-upload', `Locates the currently linked bundle in the channel you are trying to upload to, and deletes it`)
  .option('--no-brotli-patterns <patterns>', `Files to exclude from Brotli compression (comma-separated globs, e.g., "*.jpg,*.png")`)
  .option('--disable-brotli', `Completely disable brotli compression even if updater version supports it`)
  .option('--version-exists-ok', `Exit successfully if bundle version already exists, useful for CI/CD workflows with monorepos`)
  .option('--self-assign', `Allow devices to auto-join this channel (updates channel setting)`)
  .option('--qr-preview', `Print a terminal QR code for this bundle preview after upload`)
  .option('--send-update-notification', `Send a native update-check notification to devices after updating linked channel bundles`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)
  .option('--verbose', optionDescriptions.verbose)

bundle
  .command('compatibility [appId]')
  .description(`🧪 Check compatibility of a bundle with a specific channel in Capgo Cloud to ensure updates are safe.

Example: npx @capgo/cli@latest bundle compatibility com.example.app --channel production`)
  .action(checkCompatibility)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-c, --channel <channel>', `Channel to check the compatibility with`)
  .option('--text', `Output text instead of emojis`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)
  .option('--node-modules <nodeModules>', optionDescriptions.nodeModules)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

bundle
  .command('releaseType [appId]')
  .description(`🧭 Print "native" or "OTA" based on compatibility with a channel's latest metadata.

Example: npx @capgo/cli@latest bundle releaseType com.example.app --channel production`)
  .action(printReleaseType)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-c, --channel <channel>', `Channel to compare against`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)
  .option('--node-modules <nodeModules>', optionDescriptions.nodeModules)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

bundle
  .command('delete [bundleId] [appId]')
  .alias('d')
  .description(`🗑️ Delete a specific bundle from Capgo Cloud, optionally targeting a single version.

Example: npx @capgo/cli@latest bundle delete BUNDLE_ID com.example.app`)
  .action(async (bundleId: string, appId: string, options: any) => {
    await deleteBundle(bundleId, appId, options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

bundle
  .command('list [appId]')
  .alias('l')
  .description(`📋 List all bundles uploaded for an app in Capgo Cloud.

Example: npx @capgo/cli@latest bundle list com.example.app`)
  .action(async (appId: string, options: any) => {
    await listBundle(appId, options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

bundle
  .command('cleanup [appId]')
  .alias('c')
  .description(`🧹 Delete old bundles in Capgo Cloud, keeping specified number of recent versions.

Bundles linked to channels are preserved unless --ignore-channel is used.

Example: npx @capgo/cli@latest bundle cleanup com.example.app --bundle=1.0 --keep=3`)
  .action(async (appId: string, options: any) => {
    await cleanupBundle(appId, options)
  })
  .option('-b, --bundle <bundle>', `Bundle version number of the app to delete`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-k, --keep <keep>', `Number of versions to keep`)
  .option('-f, --force', `Force removal`)
  .option('--ignore-channel', `Delete bundles even if linked to channels (WARNING: deletes channels too)`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

bundle
  .command('encrypt [zipPath] [checksum]')
  .description(`🔒 Encrypt a zip bundle for secure external storage.

Returns ivSessionKey for upload/decryption. Get checksum using 'bundle zip --json'.

Example: npx @capgo/cli@latest bundle encrypt ./myapp.zip CHECKSUM`)
  .action(encryptZip)
  .option('--key <key>', `Custom path for private signing key`)
  .option('--key-data <keyData>', `Private signing key`)
  .option('-j, --json', `Output in JSON`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)

bundle
  .command('decrypt [zipPath] [checksum]')
  .description(`🔓 Decrypt an encrypted bundle (mainly for testing).

Prints base64 session key for verification.

Example: npx @capgo/cli@latest bundle decrypt ./myapp_encrypted.zip CHECKSUM`)
  .action(decryptZip)
  .option('--key <key>', `Custom path for private signing key`)
  .option('--key-data <keyData>', `Private signing key`)
  .option('--checksum <checksum>', `Checksum of the bundle, to verify the integrity of the bundle`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)

bundle
  .command('zip [appId]')
  .description(`🗜️ Create a zip file of your app bundle.

Returns checksum for use with encryption. Use --json for machine-readable output.

Example: npx @capgo/cli@latest bundle zip com.example.app --path ./dist`)
  .action(zipBundle)
  .option('-p, --path <path>', `Path of the folder to upload, if not provided it will use the webDir set in capacitor.config`)
  .option('-b, --bundle <bundle>', `Bundle version number to name the zip file`)
  .option('-n, --name <name>', `Name of the zip file`)
  .option('-j, --json', `Output in JSON`)
  .option('--no-code-check', `Ignore checking if notifyAppReady() is called in source code and index present in root folder`)
  .option('--key-v2', `Use encryption v2`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)

const app = program
  .command('app')
  .description(`📱 Manage your Capgo app settings and configurations in Capgo Cloud.`)

app
  .command('add [appId]')
  .alias('a')
  .description(`➕ Add a new app to Capgo Cloud with a unique app ID in the format com.test.app.

All options can be guessed from config if not provided.

Example: npx @capgo/cli@latest app add com.example.app --name "My App" --icon ./icon.png`)
  .action(addApp)
  .option('-n, --name <name>', `App name for display in Capgo Cloud`)
  .option('-i, --icon <icon>', `App icon path for display in Capgo Cloud`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

app
  .command('delete [appId]')
  .description(`🗑️ Delete an app from Capgo Cloud, optionally specifying a version to delete only that bundle.

Example: npx @capgo/cli@latest app delete com.example.app`)
  .action(async (appId: string, options: any) => {
    await deleteApp(appId, options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

app
  .command('list')
  .alias('l')
  .description(`📋 List all apps registered under your account in Capgo Cloud.

Example: npx @capgo/cli@latest app list`)
  .action(async (options: any) => {
    await listApp(options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

app
  .command('debug  [appId]')
  .action(debugApp)
  .description(`🐞 Listen for live update events in Capgo Cloud to debug your app.

Optionally target a specific device for detailed diagnostics.

Example: npx @capgo/cli@latest app debug com.example.app --device DEVICE_ID`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-d, --device <device>', `The specific device ID to debug`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

app
  .command('setting [path]')
  .description(`⚙️ Modify Capacitor configuration programmatically.

Specify setting path (e.g., plugins.CapacitorUpdater.defaultChannel) with --string or --bool.

Example: npx @capgo/cli@latest app setting plugins.CapacitorUpdater.defaultChannel --string "Production"`)
  .option('--bool <bool>', `A value for the setting to modify as a boolean, ex: --bool true`)
  .option('--string <string>', `A value for the setting to modify as a string, ex: --string "Production"`)
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)
  .action(setSetting)

app
  .command('set [appId]')
  .alias('s')
  .description(`⚙️ Update settings for an existing app in Capgo Cloud, such as name, icon, or retention period for bundles.

Retention of 0 means infinite storage.

Example: npx @capgo/cli@latest app set com.example.app --name "Updated App" --retention 30`)
  .action(async (appId: string, options: any) => {
    await setApp(appId, options)
  })
  .option('-n, --name <name>', `App name for display in Capgo Cloud`)
  .option('-i, --icon <icon>', `Local image file path (png, jpg, webp, svg) used as the app icon in Capgo Cloud`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-r, --retention <retention>', `Days to keep old bundles (0 = infinite, default: 0)`)
  .option('--expose-metadata <exposeMetadata>', `Expose bundle metadata (link and comment) to the plugin (true/false, default: false)`)
  .option('--preview', `Enable bundle and channel preview QR codes for this app`)
  .option('--no-preview', `Disable bundle and channel preview QR codes for this app`)
  .option('--allow-device-custom-id', `Allow devices to set a custom device ID for this app`)
  .option('--no-allow-device-custom-id', `Disallow custom device IDs for this app`)
  .option('--block-provider-infra-requests', `Block provider infrastructure requests for this app`)
  .option('--no-block-provider-infra-requests', `Allow provider infrastructure requests for this app`)
  .option('--build-timeout-minutes <minutes>', `Native build timeout in minutes (5-360, default: 15)`)
  .option('--ios-store-url <url>', `iOS App Store URL for this app`)
  .option('--android-store-url <url>', `Google Play Store URL for this app`)
  .option('--default-upload-channel <channel>', `Default upload channel name for this app`)
  .option('--default-download-channel <channel>', `Default download channel name for this app (sets channel public=true)`)
  .option('--disable-download-channels', `Disable Capgo download channels for this app (sets all channels public=false)`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

const channel = program
  .command('channel')
  .description(`📢 Manage distribution channels for app updates in Capgo Cloud, controlling how updates are delivered to devices.`)

channel
  .command('add [channelName] [appId]')
  .alias('a')
  .description(`➕ Create a new channel for app distribution in Capgo Cloud to manage update delivery.

Example: npx @capgo/cli@latest channel add production com.example.app --default`)
  .action(addChannel)
  .option('-d, --default', `Set the channel as default`)
  .option('--self-assign', `Allow device to self-assign to this channel`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

channel
  .command('delete [channelName] [appId]')
  .alias('d')
  .description(`🗑️ Delete a channel from Capgo Cloud, optionally removing associated bundles to free up resources.

Example: npx @capgo/cli@latest channel delete production com.example.app`)
  .action(async (channelId: string, appId: string, options: any) => {
    await deleteChannel(channelId, appId, options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--delete-bundle', `Delete the bundle associated with the channel`)
  .option('--success-if-not-found', `Success if the channel is not found`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

channel
  .command('list [appId]')
  .alias('l')
  .description(`📋 List all channels configured for an app in Capgo Cloud to review distribution settings.

Example: npx @capgo/cli@latest channel list com.example.app`)
  .action(async (appId: string, options: any) => {
    await listChannels(appId, options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

channel
  .command('currentBundle [channel] [appId]')
  .description(`📦 Get the current bundle linked to a specific channel in Capgo Cloud for update tracking.

Example: npx @capgo/cli@latest channel currentBundle production com.example.app`)
  .action(async (channelId: string, appId: string, options: any) => {
    await currentBundle(channelId, appId, options)
  })
  .option('-c, --channel <channel>', `Channel to get the current bundle from`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--quiet', `Only print the bundle version`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

channel
  .command('set [channelName] [appId]')
  .alias('s')
  .description(`⚙️ Configure settings for a channel, such as linking a bundle, setting update strategies (major, minor, metadata, patch, none), or device targeting (iOS, Android, dev, prod, emulator, device).

One channel must be default.

Example: npx @capgo/cli@latest channel set production com.example.app --bundle 1.0.0 --state default`)
  .action(async (channelId: string, appId: string, options: any) => {
    await setChannel(channelId, appId, options)
  })
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-b, --bundle <bundle>', `Bundle version number of the file to set`)
  .option('-s, --state <state>', `Set the state of the channel, default or normal`)
  .option('--latest-remote', `Get the latest bundle uploaded in capgo cloud and set it to the channel`)
  .option('--latest', `Get the latest version key in the package.json to set it to the channel`)
  .option('--downgrade', `Allow to downgrade to version under native one`)
  .option('--no-downgrade', `Disable downgrade to version under native one`)
  .option('--ios', `Allow sending update to iOS devices`)
  .option('--no-ios', `Disable sending update to iOS devices`)
  .option('--android', `Allow sending update to Android devices`)
  .option('--no-android', `Disable sending update to Android devices`)
  .option('--self-assign', `Allow device to self-assign to this channel`)
  .option('--no-self-assign', `Disable devices to self-assign to this channel`)
  .option('--disable-auto-update <disableAutoUpdate>', `Block updates by type: major, minor, metadata, patch, or none (allows all)`)
  .option('--rollout-bundle <rolloutBundle>', `Bundle version to release gradually on this channel`)
  .option('--rollout-percentage <rolloutPercentage>', `Rollout percentage from 0 to 100`, value => Number.parseFloat(value))
  .option('--rollout-percentage-bps <rolloutPercentageBps>', `Rollout percentage in basis points from 0 to 10000`, value => Number.parseInt(value, 10))
  .option('--rollout-enable', `Enable the configured rollout`)
  .option('--rollout-disable', `Disable the configured rollout and unlink the rollout bundle`)
  .option('--rollout-pause', `Pause rollout exposure without rolling back selected devices`)
  .option('--rollout-resume', `Resume a paused rollout`)
  .option('--rollout-rollback', `Clear rollout state and return devices to stable`)
  .option('--rollout-promote', `Promote rollout target to stable and clear rollout state`)
  .option('--rollout-cache-ttl-seconds <rolloutCacheTtlSeconds>', `Cloudflare rollout decision cache TTL in seconds`, value => Number.parseInt(value, 10))
  .option('--auto-pause-enabled', `Enable rollout auto-pause policy`)
  .option('--auto-pause-disabled', `Disable rollout auto-pause policy`)
  .option('--auto-pause-window-minutes <autoPauseWindowMinutes>', `Stats window for rollout auto-pause`, value => Number.parseInt(value, 10))
  .option('--auto-pause-failure-rate-bps <autoPauseFailureRateBps>', `Failure-rate threshold in basis points`, value => Number.parseInt(value, 10))
  .option('--auto-pause-confidence <autoPauseConfidence>', `Confidence level between 0 and 1`, value => Number.parseFloat(value))
  .option('--auto-pause-min-attempts <autoPauseMinAttempts>', `Minimum install plus fail attempts before auto-pause can trigger`, value => Number.parseInt(value, 10))
  .option('--auto-pause-min-failures <autoPauseMinFailures>', `Minimum failures before auto-pause can trigger`, value => Number.parseInt(value, 10))
  .option('--auto-pause-action <autoPauseAction>', `Auto-pause action: pause, rollback, or notify`)
  .option('--auto-pause-cooldown-minutes <autoPauseCooldownMinutes>', `Cooldown before auto-pause can trigger again`, value => Number.parseInt(value, 10))
  .option('--dev', `Allow sending update to development devices`)
  .option('--no-dev', `Disable sending update to development devices`)
  .option('--prod', `Allow sending update to production devices`)
  .option('--no-prod', `Disable sending update to production devices`)
  .option('--emulator', `Allow sending update to emulator devices`)
  .option('--no-emulator', `Disable sending update to emulator devices`)
  .option('--device', `Allow sending update to physical devices`)
  .option('--no-device', `Disable sending update to physical devices`)
  .option('--qr-preview', `Print a terminal QR code for this channel preview after updating it`)
  .option('--send-update-notification', `Send a native update-check notification to devices after updating the linked channel bundle`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)
  .option('--ignore-metadata-check', `Ignore checking node_modules compatibility if present in the bundle`)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

const key = program
  .command('key')
  .description(`🔐 Manage encryption keys for secure bundle distribution in Capgo Cloud, supporting end-to-end encryption with RSA and AES combination.`)

key
  .command('save')
  .description(`💾 Save the public key in the Capacitor config, useful for CI environments.

Recommended not to commit the key for security.

Example: npx @capgo/cli@latest key save --key ./path/to/key.pub`)
  .action(saveKeyCommand)
  .option('-f, --force', `Force generate a new one`)
  .option('--key <key>', `Key path to save in Capacitor config`)
  .option('--key-data <keyData>', `Key data to save in Capacitor config`)
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)

key
  .command('create')
  .description(`🔨 Create RSA key pair for end-to-end encryption.

Creates .capgo_key_v2 (private) and .capgo_key_v2.pub (public) in project root.
Public key is saved to capacitor.config for mobile app decryption.
NEVER commit the private key - store it securely!

Example: npx @capgo/cli@latest key create`)
  .action(createKey)
  .option('-f, --force', `Force generate a new one`)
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)

key
  .command('delete_old')
  .description(`🧹 Delete the old encryption key from the Capacitor config to ensure only the current key is used.

Example: npx @capgo/cli@latest key delete_old`)
  .action(deleteOldKey)
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)

const account = program
  .command('account')
  .description(`👤 Manage your Capgo account details and retrieve information for support or collaboration.`)

account.command('id')
  .description(`🪪 Retrieve your account ID, safe to share for collaboration or support purposes in Discord or other platforms.

Example: npx @capgo/cli@latest account id`)
  .action(getUserId)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)

const organization = program
  .command('organization')
  .description(`🏢 Manage your organizations in Capgo Cloud for team collaboration and app management.`)

organization
  .command('list')
  .alias('l')
  .description(`📋 List all organizations you have access to in Capgo Cloud.

Example: npx @capgo/cli@latest organization list`)
  .action(listOrganizations)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organization
  .command('add')
  .alias('a')
  .description(`➕ Create a new organization in Capgo Cloud for team collaboration.

Example: npx @capgo/cli@latest organization add --name "My Company" --email admin@mycompany.com`)
  .action(addOrganization)
  .option('-n, --name <name>', `Organization name`)
  .option('-e, --email <email>', `Management email for the organization`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organization
  .command('members [orgId]')
  .alias('m')
  .description(`👥 List organization members and their 2FA status.

Shows all members of an organization with their roles and whether they have 2FA enabled.
Useful before enabling 2FA enforcement to see which members will be affected.

Note: Viewing 2FA status requires super_admin rights in the organization.

Example: npx @capgo/cli@latest organization members ORG_ID`)
  .action(listMembers)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organization
  .command('set [orgId]')
  .alias('s')
  .description(`⚙️ Update organization settings including name, email, security policies, and enforcement options.

Security settings require super_admin role.

Example: npx @capgo/cli@latest organization set ORG_ID --name "New Name"
Example: npx @capgo/cli@latest organization set ORG_ID --enforce-2fa
Example: npx @capgo/cli@latest organization set ORG_ID --password-policy --min-length 12
Example: npx @capgo/cli@latest organization set ORG_ID --require-apikey-expiration --max-apikey-expiration-days 90
Example: npx @capgo/cli@latest organization set ORG_ID --enforce-hashed-api-keys`)
  .action(setOrganization)
  .option('-n, --name <name>', `Organization name`)
  .option('-e, --email <email>', `Management email for the organization`)
  .option('--enforce-2fa', `Enable 2FA enforcement for all organization members`)
  .option('--no-enforce-2fa', `Disable 2FA enforcement for organization`)
  .option('--password-policy', `Enable password policy enforcement for organization`)
  .option('--no-password-policy', `Disable password policy enforcement`)
  .option('--min-length <minLength>', `Minimum password length (6-128, default: 10)`, (val) => {
    const num = Number.parseInt(val, 10)
    if (Number.isNaN(num) || num < 6 || num > 128)
      throw new Error('min-length must be between 6 and 128')
    return num
  })
  .option('--require-uppercase', `Require uppercase letter in password`)
  .option('--no-require-uppercase', `Do not require uppercase letter`)
  .option('--require-number', `Require number in password`)
  .option('--no-require-number', `Do not require number`)
  .option('--require-special', `Require special character in password`)
  .option('--no-require-special', `Do not require special character`)
  .option('--require-apikey-expiration', `Require all API keys to have an expiration date`)
  .option('--no-require-apikey-expiration', `Do not require API key expiration`)
  .option('--max-apikey-expiration-days <days>', `Maximum days before API key expiration (1-365, null for no limit)`, (val) => {
    if (val === 'null' || val === '')
      return null
    const num = Number.parseInt(val, 10)
    if (Number.isNaN(num) || num < 1 || num > 365)
      throw new Error('max-apikey-expiration-days must be between 1 and 365, or null')
    return num
  })
  .option('--enforce-hashed-api-keys', `Enforce hashed/secure API keys (key value stored as hash, shown only once)`)
  .option('--no-enforce-hashed-api-keys', `Allow plain-text API keys`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organization
  .command('delete [orgId]')
  .alias('d')
  .description(`🗑️ Delete an organization from Capgo Cloud. This action cannot be undone.

Only organization owners can delete organizations.

Example: npx @capgo/cli@latest organization delete ORG_ID`)
  .action(deleteOrganization)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

// Deprecated alias for backward compatibility
function warnDeprecated() {
  console.warn('⚠️  Warning: "organisation" is deprecated. Please use "organization" instead.')
}

const organisation = program
  .command('organisation')
  .description(`[DEPRECATED] Use "organization" instead. This command will be removed in a future version.`)
  .hook('preAction', warnDeprecated)

organisation
  .command('list')
  .alias('l')
  .description(`[DEPRECATED] Use "organization list" instead.`)
  .action(listOrganizations)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organisation
  .command('add')
  .alias('a')
  .description(`[DEPRECATED] Use "organization add" instead.`)
  .action(addOrganization)
  .option('-n, --name <name>', `Organization name`)
  .option('-e, --email <email>', `Management email for the organization`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organisation
  .command('set [orgId]')
  .alias('s')
  .description(`[DEPRECATED] Use "organization set" instead.`)
  .action(setOrganization)
  .option('-n, --name <name>', `Organization name`)
  .option('-e, --email <email>', `Management email for the organization`)
  .option('--enforce-2fa', `Enable 2FA enforcement for all organization members`)
  .option('--no-enforce-2fa', `Disable 2FA enforcement for organization`)
  .option('--password-policy', `Enable password policy enforcement for organization`)
  .option('--no-password-policy', `Disable password policy enforcement`)
  .option('--min-length <minLength>', `Minimum password length (6-128, default: 10)`, (val) => {
    const num = Number.parseInt(val, 10)
    if (Number.isNaN(num) || num < 6 || num > 128)
      throw new Error('min-length must be between 6 and 128')
    return num
  })
  .option('--require-uppercase', `Require uppercase letter in password`)
  .option('--no-require-uppercase', `Do not require uppercase letter`)
  .option('--require-number', `Require number in password`)
  .option('--no-require-number', `Do not require number`)
  .option('--require-special', `Require special character in password`)
  .option('--no-require-special', `Do not require special character`)
  .option('--require-apikey-expiration', `Require all API keys to have an expiration date`)
  .option('--no-require-apikey-expiration', `Do not require API key expiration`)
  .option('--max-apikey-expiration-days <days>', `Maximum days before API key expiration (1-365, null for no limit)`, (val) => {
    if (val === 'null' || val === '')
      return null
    const num = Number.parseInt(val, 10)
    if (Number.isNaN(num) || num < 1 || num > 365)
      throw new Error('max-apikey-expiration-days must be between 1 and 365, or null')
    return num
  })
  .option('--enforce-hashed-api-keys', `Enforce hashed/secure API keys (key value stored as hash, shown only once)`)
  .option('--no-enforce-hashed-api-keys', `Allow plain-text API keys`)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

organisation
  .command('delete [orgId]')
  .alias('d')
  .description(`[DEPRECATED] Use "organization delete" instead.`)
  .action(deleteOrganization)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

const build = program
  .command('build')
  .description(`🏗️  Manage native iOS/Android builds through Capgo Cloud.

⚠️ Native cloud build requests are currently in LIMITED BETA. Access is restricted.

 🔒 SECURITY GUARANTEE:
    Build credentials are NEVER stored on Capgo servers.
    They are used only during the build and auto-deleted after.
    Build outputs may optionally be uploaded for time-limited download links.

📋 BEFORE BUILDING:
   Save your credentials first:
   npx @capgo/cli build credentials save --appId <your-app-id> --platform ios
   npx @capgo/cli build credentials save --appId <your-app-id> --platform android

📤 CAPTURE THE OUTPUT URL FROM CI:
   Pass --output-record to persist the download URL + QR code, then read it
   back with \`build last-output\`:
   npx @capgo/cli build request <appId> --platform android --output-upload --output-record /tmp/build.json
   URL=$(npx @capgo/cli build last-output --path /tmp/build.json --field outputUrl)`)

build
  .command('needed [appId]')
  .description(`🧭 Print "yes" and exit with code 1 if a native build is required; otherwise print "no" and exit with code 0. Command failures exit with code 2.

Example: npx @capgo/cli@latest build needed com.example.app --channel production --verbose`)
  .action(checkBuildNeeded)
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('-c, --channel <channel>', `Channel to compare against. Defaults to CapacitorUpdater.defaultChannel or the public default channel`)
  .option('--package-json <packageJson>', optionDescriptions.packageJson)
  .option('--node-modules <nodeModules>', optionDescriptions.nodeModules)
  .option('--verbose', optionDescriptions.verbose)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)

build
  .command('init')
  .alias('onboarding')
  .description('Set up build credentials interactively (iOS: certificates + profiles automated; Android: keystore + Google OAuth provisions GCP service account and Play Console invite)')
  .option('-a, --apikey <apikey>', 'API key to link to your account')
  .option('-p, --platform <platform>', 'Platform to onboard (ios or android). If omitted, auto-detects when only one native folder exists; prompts otherwise.')
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--no-analytics', 'Disable build onboarding analytics and terminal replay for this run')
  // enableSelfUpdate is set ONLY here (the genuine `build init` entrypoint) so
  // the self-update prompt's re-exec replays `build init`, never a wrapper
  // command that reached onboarding as a sub-step (bundle upload / credentials).
  .action((options: OnboardingBuilderOptions) => onboardingBuilderCommand({ ...options, enableSelfUpdate: true }))

build
  .command('request [appId]')
  .description(`Request a native build from Capgo Cloud.

This command zips your project and uploads it to Capgo for a remote native build.
By default the finished artifact can go to the app store (when store credentials are saved)
and/or to Capgo storage as a time-limited download link (--output-upload).

 🔒 SECURITY: Credentials are never stored on Capgo servers. They are auto-deleted
    after build completion. Build outputs may optionally be uploaded for time-limited download links.

📋 PREREQUISITE: Save credentials first with:
   \`npx @capgo/cli@latest build credentials save --appId <app-id> --platform <ios|android>\`

Example: npx @capgo/cli@latest build request com.example.app --platform ios --path .
Android AAB only (no Play upload): npx @capgo/cli@latest build request com.example.app --platform android --no-playstore-upload --output-upload
iOS IPA only (no TestFlight upload): npx @capgo/cli@latest build request com.example.app --platform ios --ios-distribution ad_hoc --output-upload`)
  .action(requestBuildCommand)
  .option('--path <path>', `Path to the project directory to build (default: current directory)`)
  .option('--node-modules <nodeModules>', optionDescriptions.nodeModules)
  .option('--platform <platform>', `Target platform: ios or android (required)`)
  .option('--build-mode <buildMode>', `Build mode: debug or release (default: release)`)
  // iOS credential CLI options (can also be set via env vars or saved credentials)
  .option('--build-certificate-base64 <cert>', 'iOS: Base64-encoded .p12 certificate')
  .option('--p12-password <password>', 'iOS: Certificate password (optional if cert has no password)')
  .option('--apple-id <email>', 'iOS: Apple ID email for app-specific password uploads (alternative to App Store Connect API key)')
  .option('--apple-app-specific-password <password>', 'iOS: App-specific password (xxxx-xxxx-xxxx-xxxx) for TestFlight uploads')
  .option('--apple-app-id <id>', 'iOS: Numeric App Store Connect app id (required together with --apple-id and --apple-app-specific-password)')
  .option('--apple-key-id <id>', 'iOS: App Store Connect API Key ID')
  .option('--apple-issuer-id <id>', 'iOS: App Store Connect Issuer ID')
  .option('--apple-key-content <content>', 'iOS: Base64-encoded App Store Connect API key (.p8)')
  .option('--app-store-connect-team-id <id>', 'iOS: App Store Connect Team ID')
  .option('--ios-scheme <scheme>', 'iOS: Xcode scheme to build (default: App)')
  .option('--ios-target <target>', 'iOS: Xcode target for reading build settings (default: same as scheme)')
  .addOption(new Option('--ios-distribution <mode>', 'iOS: Distribution mode. app_store (default) uploads to TestFlight/App Store; ad_hoc skips store upload and builds an Ad Hoc IPA for device install. Use ad_hoc with --output-upload when the App Store app does not exist yet or you only need an IPA download.').choices(['app_store', 'ad_hoc']).default('app_store'))
  .option('--ios-provisioning-profile <mapping>', 'iOS: Provisioning profile path or bundleId=path mapping (repeatable)', collect, [])
  // Android credential CLI options (can also be set via env vars or saved credentials)
  .option('--android-keystore-file <keystore>', 'Android: Base64-encoded keystore file')
  .option('--keystore-key-alias <alias>', 'Android: Keystore key alias')
  .option('--keystore-key-password <password>', 'Android: Keystore key password')
  .option('--keystore-store-password <password>', 'Android: Keystore store password')
  .option('--play-config-json <json>', 'Android: Base64-encoded Google Play service account JSON')
  .option('--android-flavor <flavor>', 'Android: Product flavor to build (e.g. production). Required if your project has multiple flavors.')
  .option('--in-app-update-priority <priority>', 'Android: Google Play in-app update priority for this release (integer 0–5; higher = more urgent). See https://developer.android.com/guide/playcore/in-app-updates. Precedence: CLI > env > saved credentials')
  .option('--no-playstore-upload', 'Android: do not upload the AAB/APK to Google Play for this build (ignores saved Play credentials). Use when the Play app does not exist yet, or you only want a Capgo download link. Requires --output-upload.')
  .option('--submit-to-store-review', 'After upload, submit the store release for review instead of leaving it as a draft/inactive build. Android marks the Play release completed; iOS submits the processed TestFlight build to App Store review.')
  .option('--store-release-name <name>', 'Store release name/version label. Android sends this as the Google Play version_name; iOS uses it as the App Store version when creating or reusing the editable version.')
  .option('--store-release-notes <notes>', 'Default store release notes. Android uses this as the Play changelog; iOS uses it as the fallback App Store What\'s New text.')
  .option('--store-release-notes-locale <locale=notes>', 'Localized store release notes (repeatable), for example --store-release-notes-locale en-US="Bug fixes" --store-release-notes-locale fr-FR="Corrections".', collect, [])
  .option('--ios-testflight-groups <groups>', 'iOS: optional comma-separated TestFlight external group names or IDs for external beta distribution.')
  .option('--ios-automatic-release', 'iOS: automatically release the App Store version after Apple approval. Default is manual release.')
  .option('--no-ios-automatic-release', 'iOS: keep the App Store version waiting for manual release after Apple approval.')
  .option('--output-upload', 'Upload the finished IPA/APK/AAB to Capgo storage and print a time-limited download link (and QR). Use with --no-playstore-upload (Android) or --ios-distribution ad_hoc (iOS) when you only need the artifact and are not publishing to the store yet. Precedence: CLI > env > saved credentials')
  .option('--no-output-upload', 'Do not upload the finished IPA/APK/AAB to Capgo storage (no download link). Store upload still happens when Play/TestFlight credentials are configured. Precedence: CLI > env > saved credentials')
  .option('--output-retention <duration>', 'Override output link TTL for this build only (1h to 7d). Examples: 1h, 6h, 2d. Precedence: CLI > env > saved credentials')
  .option('--output-record <path>', 'After a successful build, write a JSON record (jobId, status, outputUrl, qrCodeAscii, qrCodePngPath, finishedAt) to <path>. A PNG QR code is also written next to it as <path>.qr.png. Read fields back with `build last-output`.')
  .option('--skip-build-number-bump', 'Skip automatic build number/version code incrementing. Uses whatever version is already in the project files.')
  .option('--no-skip-build-number-bump', 'Override saved credentials to re-enable automatic build number incrementing for this build only.')
  .option('--skip-marketing-version-bump', 'Skip automatic marketing version (CFBundleShortVersionString / versionName) bump when the app is already released.')
  .option('--no-skip-marketing-version-bump', 'Override saved credentials to re-enable automatic marketing version bump for this build only.')
  .option('--sync-ios-version', 'iOS: sync Xcode MARKETING_VERSION from package.json before uploading the project.')
  .option('--ai-analytics', 'On build failure, send logs to Capgo AI for diagnosis. In interactive terminals this skips the upfront confirmation; in CI this auto-uploads and prints the analysis to stderr.')
  .option('--no-prescan', 'Skip the automatic pre-build scan')
  .option('--prescan-ignore-fatal', 'Run the pre-build scan but never block the build (report only)')
  .option('--prescan-skip <checkId>', 'Skip specific prescan check(s) by id (repeatable or comma-separated). Other checks still run.', collect, [])
  .option('--prescan-warn <checkId>', 'Downgrade specific prescan check(s) to warning by id (repeatable or comma-separated). Check still runs.', collect, [])
  .option('--fail-on-warnings', 'Treat prescan warnings as fatal')
  .option('--send-logs-to-support', 'On a CI/CD build failure, automatically upload the build logs to Capgo support (no email required). Capgo support is notified and will follow up by email. Additive to --ai-analytics.')
  .addOption(new Option('--send-logs', 'Deprecated alias for --send-logs-to-support').hideHelp())
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)
  .option('--verbose', optionDescriptions.verbose)

build
  .command('sync-ios-version')
  .description(`Sync the local iOS Xcode MARKETING_VERSION from package.json.

Example: npx @capgo/cli@latest build sync-ios-version --path .`)
  .option('--path <path>', 'Path to the project directory (default: current directory)')
  .option('--check', 'Check only; exit non-zero when MARKETING_VERSION is out of sync')
  .action(syncIosMarketingVersionCommand)

build
  .command('prescan [appId]')
  .description(`Scan your project and saved credentials for problems that would fail a cloud build — before uploading anything.

Checks credentials (expiry, passwords, profile pairing), project state (cap sync, node_modules layout), and platform config. Runs automatically inside \`build request\`; this command runs it standalone (e.g. in CI).`)
  .option('--platform <platform>', 'Target platform: ios or android (required)')
  .option('--path <path>', 'Path to the project directory (default: current directory)')
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--android-flavor <flavor>', 'Android: product flavor the build will use')
  .addOption(new Option('--ios-dist <mode>', 'iOS: distribution mode to validate against').choices(['app_store', 'ad_hoc']))
  .option('--json', 'Output a machine-readable JSON report')
  .option('--fail-on-warnings', 'Exit non-zero when warnings are found (CI)')
  .option('--ignore-fatal', 'Diagnostic mode: report everything but always exit 0')
  .option('--skip <checkId>', 'Skip specific check(s) by id (repeatable or comma-separated). Alias of --prescan-skip on build request.', collect, [])
  .option('--warn <checkId>', 'Downgrade specific check(s) to warning by id (repeatable or comma-separated). Alias of --prescan-warn on build request.', collect, [])
  .option('--verbose', optionDescriptions.verbose)
  .option('--supa-host <supaHost>', optionDescriptions.supaHost)
  .option('--supa-anon <supaAnon>', optionDescriptions.supaAnon)
  .action(prescanCommand)

build
  .command('last-output')
  .description(`Read the build output record written by a previous \`build request --output-record\`.

Prints the full JSON by default, a single field with --field, or the ASCII QR
code with --qr. Useful in CI to grab the download URL or QR for posting back
to a PR or issue.

Examples:
  npx @capgo/cli build last-output --path /tmp/build.json
  npx @capgo/cli build last-output --path /tmp/build.json --field outputUrl
  npx @capgo/cli build last-output --path /tmp/build.json --qr`)
  .action(lastOutputCommand)
  .option('--path <path>', 'Path to the JSON record written by --output-record (required)')
  .option('--field <field>', 'Print a single field (one of: jobId, appId, platform, buildMode, status, outputUrl, qrCodeAscii, qrCodePngPath, finishedAt, schemaVersion)')
  .option('--qr', 'Print the rendered ASCII QR code (shortcut for --field qrCodeAscii)')

const buildCredentials = build
  .command('credentials')
  .description(`Manage build credentials stored locally on your machine.

🔒 SECURITY:
   - Credentials saved to ~/.capgo-credentials/credentials.json (global) or .capgo-credentials.json (local)
   - When building, sent to Capgo but NEVER stored permanently
   - Deleted from Capgo immediately after build
   - Build outputs may optionally be uploaded for time-limited download links

📚 DOCUMENTATION:
   iOS setup: https://capgo.app/docs/cli/cloud-build/ios/
   Android setup: https://capgo.app/docs/cli/cloud-build/android/`)

buildCredentials
  .command('apple-key')
  .alias('asc-key')
  .description(`Create an App Store Connect team API key with a guided macOS helper (macOS only).

Opens a native window that walks you through Apple's App Store Connect UI in an
embedded browser, auto-captures the Issuer ID + Key ID, intercepts the one-time
.p8, validates it against Apple, and saves it to ~/.appstoreconnect/private_keys.
Progress statistics are forwarded to Capgo analytics (disable with CAPGO_DISABLE_TELEMETRY).

Example:
  npx @capgo/cli build credentials apple-key --appId com.example.app`)
  .action((options: CreateAppleKeyOptions) => createAppleKeyCommand(options))
  .option('-a, --apikey <apikey>', optionDescriptions.apikey)
  .option('--appId <appId>', 'Save the captured key into this app iOS build credentials')
  .option('--local', 'Save into the per-project .capgo-credentials.json instead of the global file')
  .option('--json', 'Print the captured Key ID / Issuer ID / .p8 path as JSON')

buildCredentials
  .command('save')
  .description(`Save build credentials locally for iOS or Android.

Credentials are stored in:
  - ~/.capgo-credentials/credentials.json (default, global)
  - .capgo-credentials.json in project root (with --local flag)

⚠️  REQUIRED BEFORE BUILDING: You must save credentials before requesting a build.

🔒 These credentials are NEVER stored on Capgo servers permanently.
   They are deleted immediately after the build completes.

📚 Setup guides:
   iOS: https://capgo.app/docs/cli/cloud-build/ios/
   Android: https://capgo.app/docs/cli/cloud-build/android/

iOS Example:
  npx @capgo/cli build credentials save --platform ios \\
    --certificate ./cert.p12 --p12-password "password" \\
    --ios-provisioning-profile ./profile.mobileprovision \\
    --apple-key ./AuthKey.p8 --apple-key-id "KEY123" \\
    --apple-issuer-id "issuer-uuid" --apple-team-id "team-id"

Multi-target Example (app + widget extension):
  npx @capgo/cli build credentials save --platform ios \\
    --ios-provisioning-profile ./App.mobileprovision \\
    --ios-provisioning-profile com.example.widget=./Widget.mobileprovision \\
    ...

Android Example:
  npx @capgo/cli build credentials save --platform android \\
    --keystore ./release.keystore --keystore-alias "my-key" \\
    --keystore-key-password "key-pass" \\
    --play-config ./service-account.json

Local storage (per-project):
  npx @capgo/cli build credentials save --local --platform ios ...`)
  .action(saveCredentialsCommand)
  .option('--appId <appId>', 'App ID (e.g., com.example.app) (required)')
  .option('--platform <platform>', 'Platform: ios or android (required)')
  // iOS options
  .option('--certificate <path>', 'iOS: Path to .p12 certificate file')
  .option('--ios-provisioning-profile <mapping>', 'iOS: Provisioning profile path or bundleId=path (repeatable)', collect, [])
  .option('--p12-password <password>', 'iOS: Certificate password (optional if cert has no password)')
  .option('--apple-key <path>', 'iOS: Path to .p8 App Store Connect API key')
  .option('--apple-key-id <id>', 'iOS: App Store Connect API Key ID')
  .option('--apple-issuer-id <id>', 'iOS: App Store Connect Issuer ID')
  .option('--apple-team-id <id>', 'iOS: App Store Connect Team ID')
  .addOption(new Option('--ios-distribution <mode>', 'iOS: Distribution mode').choices(['app_store', 'ad_hoc']).default('app_store'))
  .option('--apple-id <email>', 'iOS: Apple ID email for app-specific password uploads (alternative to App Store Connect API key)')
  .option('--apple-app-specific-password <password>', 'iOS: App-specific password (xxxx-xxxx-xxxx-xxxx) for TestFlight uploads')
  .option('--apple-app-id <id>', 'iOS: Numeric App Store Connect app id (required together with --apple-id and --apple-app-specific-password)')
  // Android options
  .option('--keystore <path>', 'Android: Path to keystore file (.keystore or .jks)')
  .option('--keystore-alias <alias>', 'Android: Keystore key alias')
  .option('--keystore-key-password <password>', 'Android: Keystore key password')
  .option('--keystore-store-password <password>', 'Android: Keystore store password')
  .option('--play-config <path>', 'Android: Path to Play Store service account JSON')
  .option('--android-flavor <flavor>', 'Android: Product flavor to build (e.g. production). Required if your project has multiple flavors.')
  .option('--in-app-update-priority <priority>', 'Android: Google Play in-app update priority for future releases (integer 0–5; higher = more urgent). Omit to leave Play’s existing value untouched.')
  // Storage option
  .option('--local', 'Save to .capgo-credentials.json in project root instead of global ~/.capgo-credentials/')
  .option('--output-upload', 'Upload build outputs (IPA/APK/AAB) to Capgo storage and print download links')
  .option('--no-output-upload', 'Do not upload build outputs (IPA/APK/AAB) to Capgo storage')
  .option('--output-retention <duration>', 'Output link TTL: 1h to 7d (default: 1h). Examples: 1h, 6h, 2d')
  .option('--skip-build-number-bump', 'Skip automatic build number/version code incrementing on future builds')
  .option('--no-skip-build-number-bump', 'Re-enable automatic build number incrementing (default behavior)')
  .option('--skip-marketing-version-bump', 'Skip automatic marketing version bump on future builds when the app is already released')
  .option('--no-skip-marketing-version-bump', 'Re-enable automatic marketing version bump (default behavior)')

buildCredentials
  .command('list')
  .description(`List saved build credentials (passwords masked).

Shows what credentials are currently saved (both global and local).

Examples:
  npx @capgo/cli build credentials list  # List all apps
  npx @capgo/cli build credentials list --appId com.example.app  # List specific app`)
  .action(listCredentialsCommand)
  .option('--appId <appId>', 'App ID to list (optional, lists all if omitted)')
  .option('--local', 'List credentials from local .capgo-credentials.json only')

buildCredentials
  .command('clear')
  .description(`Clear saved build credentials.

Remove credentials from storage.
Use --appId and --platform to target specific credentials.

Examples:
  npx @capgo/cli build credentials clear  # Clear all apps (global)
  npx @capgo/cli build credentials clear --local  # Clear local credentials
  npx @capgo/cli build credentials clear --appId com.example.app --platform ios`)
  .action(clearCredentialsCommand)
  .option('--appId <appId>', 'App ID to clear (optional, clears all apps if omitted)')
  .option('--platform <platform>', 'Platform to clear: ios or android (optional, clears all platforms if omitted)')
  .option('--local', 'Clear from local .capgo-credentials.json instead of global')

buildCredentials
  .command('update')
  .description(`Update specific credentials without providing all of them again.

Update existing credentials by providing only the fields you want to change.
Platform is auto-detected from the options you provide.

Examples:
  npx @capgo/cli build credentials update --ios-provisioning-profile ./new-profile.mobileprovision
  npx @capgo/cli build credentials update --local --keystore ./new-keystore.jks`)
  .action(updateCredentialsCommand)
  .option('--appId <appId>', 'App ID (auto-detected from capacitor.config if omitted)')
  .option('--platform <platform>', 'Platform: ios or android (auto-detected from options)')
  .option('--local', 'Update local .capgo-credentials.json instead of global')
  // iOS options
  .option('--certificate <path>', 'Path to P12 certificate file')
  .option('--ios-provisioning-profile <mapping>', 'Provisioning profile path or bundleId=path (repeatable, additive by default)', collect, [])
  .option('--overwrite-ios-provisioning-map', 'Replace the entire provisioning map instead of merging (default: merge)')
  .option('--p12-password <password>', 'P12 certificate password')
  .option('--apple-key <path>', 'Path to App Store Connect API key (.p8 file)')
  .option('--apple-key-id <id>', 'App Store Connect API Key ID')
  .option('--apple-issuer-id <id>', 'App Store Connect Issuer ID')
  .option('--apple-team-id <id>', 'App Store Connect Team ID')
  .option('--apple-id <email>', 'iOS: Apple ID email for app-specific password uploads (alternative to App Store Connect API key)')
  .option('--apple-app-specific-password <password>', 'iOS: App-specific password (xxxx-xxxx-xxxx-xxxx) for TestFlight uploads')
  .option('--apple-app-id <id>', 'iOS: Numeric App Store Connect app id (required together with --apple-id and --apple-app-specific-password)')
  .addOption(new Option('--ios-distribution <mode>', 'iOS: Distribution mode').choices(['app_store', 'ad_hoc']).default('app_store'))
  // Android options
  .option('--keystore <path>', 'Path to keystore file (.keystore or .jks)')
  .option('--keystore-alias <alias>', 'Keystore key alias')
  .option('--keystore-key-password <password>', 'Keystore key password')
  .option('--keystore-store-password <password>', 'Keystore store password')
  .option('--play-config <path>', 'Path to Google Play service account JSON')
  .option('--android-flavor <flavor>', 'Android: Product flavor to build (e.g. production). Required if your project has multiple flavors.')
  .option('--in-app-update-priority <priority>', 'Android: Google Play in-app update priority for future releases (integer 0–5; higher = more urgent).')
  .option('--output-upload', 'Upload build outputs (IPA/APK/AAB) to Capgo storage and print download links')
  .option('--no-output-upload', 'Do not upload build outputs (IPA/APK/AAB) to Capgo storage')
  .option('--output-retention <duration>', 'Output link TTL: 1h to 7d. Examples: 1h, 6h, 2d')
  .option('--skip-build-number-bump', 'Skip automatic build number/version code incrementing on future builds')
  .option('--no-skip-build-number-bump', 'Re-enable automatic build number incrementing (default behavior)')
  .option('--skip-marketing-version-bump', 'Skip automatic marketing version bump on future builds when the app is already released')
  .option('--no-skip-marketing-version-bump', 'Re-enable automatic marketing version bump (default behavior)')

buildCredentials
  .command('manage')
  .description(`Interactively manage saved build credentials.

Browse stored credentials, view what's configured, export a CI/CD-ready .env file,
or delete a platform's credentials. Reuses the same TUI as \`capgo init\`.

Examples:
  npx @capgo/cli build credentials manage
  npx @capgo/cli build credentials manage --appId com.example.app
  npx @capgo/cli build credentials manage --appId com.example.app --platform ios
  npx @capgo/cli build credentials manage --local`)
  .action(manageCredentialsCommand)
  .option('--appId <appId>', 'App ID to manage (optional, prompts to pick if omitted)')
  .option('--platform <platform>', 'Platform to manage: ios or android (optional, prompts to pick if omitted)')
  .option('--local', 'Only browse local .capgo-credentials.json')

buildCredentials
  .command('migrate')
  .description(`Migrate legacy provisioning profile to the new multi-target format.

Converts BUILD_PROVISION_PROFILE_BASE64 to CAPGO_IOS_PROVISIONING_MAP.
Discovers the main bundle ID from your Xcode project automatically.

Example:
  npx @capgo/cli build credentials migrate --platform ios`)
  .action(migrateCredentialsCommand)
  .option('--appId <appId>', 'App ID (auto-detected from capacitor.config if omitted)')
  .option('--platform <platform>', 'Platform (only ios is supported)')
  .option('--local', 'Migrate from local .capgo-credentials.json instead of global')

program
  .command('notifications')
  .description(`🔔 Set up Capgo native notifications in your Capacitor app.`)
  .command('setup [appId]')
  .description(`Install the Capgo notifications plugin, add Capacitor config, create a helper file, and run Capacitor sync.

Before sending production notifications, configure Android and iOS push credentials in the Capgo app Notifications tab.

Example: npx @capgo/cli@latest notifications setup com.example.app`)
  .action(setupNotifications)
  .option('--server-url <serverUrl>', 'Capgo API server URL')
  .option('--file <file>', 'Helper file to create (default: src/capgo-notifications.ts)')
  .option('--force', 'Overwrite the helper file if it already exists')
  .option('--no-install', 'Skip installing the notifications package')
  .option('--no-sync', 'Skip Capacitor sync')
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)

program
  .command('probe')
  .description(`🔎 Probe the Capgo updates endpoint to check if an update is available for your app.

Sends a single request to the updates endpoint using your project's capacitor config
and reports whether an update would be delivered, or explains why not.

Example: npx @capgo/cli@latest probe --platform ios`)
  .option('--platform <platform>', 'Platform to probe: ios or android')
  .action(probe)

program
  .command('generate-docs [filePath]')
  .description('Generate Markdown documentation for CLI commands - either for README or individual files')
  .option('--folder <folderPath>', 'Generate individual markdown files for each command in the specified folder (instead of updating README)')
  .action((filePath, options) => {
    generateDocs(filePath, options.folder)
  })

program
  .command('mcp')
  .description(`🤖 Start the Capgo MCP (Model Context Protocol) server for AI agent integration.

This command starts an MCP server that exposes Capgo functionality as tools for AI agents.
The server communicates via stdio and is designed for non-interactive, programmatic use.

Selected tools exposed via MCP:
  - capgo_list_apps, capgo_add_app, capgo_update_app, capgo_delete_app
  - capgo_upload_bundle, capgo_list_bundles, capgo_delete_bundle, capgo_cleanup_bundles
  - capgo_list_channels, capgo_add_channel, capgo_update_channel, capgo_delete_channel
  - capgo_get_current_bundle, capgo_check_compatibility
  - capgo_list_organizations, capgo_add_organization
  - capgo_star_repository
  - capgo_star_all_repositories
  - capgo_get_account_id, capgo_doctor, capgo_get_stats
  - capgo_request_build, capgo_generate_encryption_keys

Example usage with Claude Desktop:
  Add to claude_desktop_config.json:
  {
    "mcpServers": {
      "capgo": {
        "command": "npx",
        "args": ["@capgo/cli@latest", "mcp"]
      }
    }
  }

Example: npx @capgo/cli@latest mcp`)
  .option('--capacitor-config <path>', optionDescriptions.capacitorConfig)
  .action(async () => {
    await startMcpServer(getConfigWriteTarget())
  })

program.exitOverride()
program.configureOutput({
  writeErr: (_str) => {
    // Suppress Commander's default error output since we handle it in catch
  },
})
applyRawCommandAnalyticsOptOut(process.argv)

void (async () => {
  try {
    await program.parseAsync()
    await flushAnalytics()
  }
  catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const commanderError = error as { code: string, exitCode?: number, message?: string }
      // These are normal Commander.js exits (help, version, etc.) - exit silently
      if (commanderError.code === 'commander.version' || commanderError.code === 'commander.helpDisplayed') {
        await flushAnalytics()
        exit(0)
      }
      const capturePromise = shouldCapturePosthogException(error)
        ? capturePosthogException({
          error,
          functionName: currentCommandPath,
          kind: 'unhandled_error',
          status: commanderError.exitCode ?? 1,
        })
        : Promise.resolve(false)
      // For actual errors, show just the message without the full stack trace
      if (commanderError.message) {
        log.error(commanderError.message)
      }
      const exitCode = commanderError.exitCode ?? 1
      // Track the failure for usage analytics regardless of exception-capture
      // policy (commander usage errors are real failures, categorized 'commander').
      trackCommandFailed(currentCommandPath, { errorCategory: categorizeCliError(error), exitCode })
      await Promise.all([capturePromise, flushAnalytics(), finishActiveCliReplay().catch(() => {})])
      exit(exitCode)
    }
    const capturePromise = capturePosthogException({
      error,
      functionName: currentCommandPath,
      kind: 'unhandled_error',
      status: 1,
    })
    // For non-Commander errors, show full error details
    log.error(`Error: ${formatError(error)}`)
    trackCommandFailed(currentCommandPath, { errorCategory: categorizeCliError(error), exitCode: 1 })
    await Promise.all([capturePromise, flushAnalytics(), finishActiveCliReplay().catch(() => {})])
    exit(1)
  }
})()
