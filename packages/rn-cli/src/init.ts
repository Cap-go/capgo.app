import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { log, note } from '@clack/prompts'
import color from 'picocolors'

export interface InitOptions {
  project: string
}

export async function runInit(options: InitOptions): Promise<void> {
  const project = resolve(options.project)
  const pkgPath = join(project, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json in ${project}`)
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const hasUpdater = Boolean(deps['@capgo/react-native-updater'])
  const hasCli = Boolean(deps['@capgo/rn-cli'] || deps['@capgo/cli'])

  log.info(hasUpdater
    ? color.green('@capgo/react-native-updater is installed')
    : color.yellow('Install: npm install @capgo/react-native-updater'))
  log.info(hasCli
    ? color.green('Capgo CLI present')
    : color.yellow('Install: npm install -D @capgo/rn-cli @capgo/cli'))

  note(
    [
      '1. Wire Android getJSBundleFile() -> CapgoUpdater.getJSBundleFile(context)',
      '2. Wire iOS sourceURLForBridge -> CapgoUpdater.getJSBundleURL()',
      '3. Add CapgoAppId / CapgoUpdateUrl / CapgoStatsUrl to Info.plist + AndroidManifest',
      '4. Call CapgoUpdater.notifyAppReady() on app start',
      '5. Upload: npx @capgo/rn-cli@latest upload <appId> --channel production',
      '',
      'Delta system: Capgo file-level SHA-256 manifests (+ optional Brotli), same as Capacitor.',
    ].join('\n'),
    'React Native Capgo setup',
  )
}
