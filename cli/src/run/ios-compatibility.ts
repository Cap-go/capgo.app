import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { canParse, greaterThan, parse } from '@std/semver'
import { z } from 'zod'

export const IOS_SIMULATOR_ISSUE_URL = 'https://github.com/ionic-team/capacitor/issues/8620'
export const LAST_UNSUPPORTED_NATIVE_RUN_VERSION = '2.0.3'

const packageVersionSchema = z.object({ version: z.string() })

interface IosSimulatorVersions {
  capacitorCliVersion: string | null
  nativeRunVersion: string | null
}

export type IosSimulatorCompatibility
  = | { kind: 'unaffected' }
    | ({ kind: 'supported' | 'unsupported' | 'unknown' } & IosSimulatorVersions)

function readPackageVersion(packageJsonPath: string): string | null {
  const result = packageVersionSchema.safeParse(JSON.parse(readFileSync(packageJsonPath, 'utf8')))
  return result.success ? result.data.version : null
}

function readNativeRun(projectDir: string): IosSimulatorVersions & { simulatorSource: string | null } {
  let capacitorCliVersion: string | null = null
  let nativeRunVersion: string | null = null
  let simulatorSource: string | null = null
  try {
    const projectRequire = createRequire(resolve(projectDir, 'package.json'))
    const cliPackageJson = realpathSync(projectRequire.resolve('@capacitor/cli/package.json'))
    capacitorCliVersion = readPackageVersion(cliPackageJson)
    // Resolve from Capacitor itself. A top-level native-run can be a different version.
    const cliRequire = createRequire(cliPackageJson)
    const nativeRunPackageJson = cliRequire.resolve('native-run/package.json')
    nativeRunVersion = readPackageVersion(nativeRunPackageJson)
    simulatorSource = readFileSync(join(dirname(nativeRunPackageJson), 'dist/ios/utils/simulator.js'), 'utf8')
  }
  catch {
    // Missing packages or a changed native-run layout leave compatibility unverified.
  }
  return { capacitorCliVersion, nativeRunVersion, simulatorSource }
}

export function checkIosSimulatorCompatibility(
  projectDir: string,
  { hostPlatform = process.platform, developerDir = process.env.DEVELOPER_DIR }: {
    hostPlatform?: NodeJS.Platform
    developerDir?: string
  } = {},
): IosSimulatorCompatibility {
  if (hostPlatform !== 'darwin')
    return { kind: 'unaffected' }

  if (!developerDir) {
    const selectedXcode = spawnSync('xcode-select', ['--print-path'], { encoding: 'utf8', timeout: 5000 })
    if (selectedXcode.status === 0)
      developerDir = selectedXcode.stdout.trim()
  }

  if (!developerDir)
    return { kind: 'unknown', capacitorCliVersion: null, nativeRunVersion: null }

  // DEVELOPER_DIR accepts either Xcode.app or its Contents/Developer directory.
  developerDir = resolve(developerDir)
  if (developerDir.endsWith('.app'))
    developerDir = join(developerDir, 'Contents', 'Developer')

  const hasSimulator = existsSync(join(developerDir, 'Applications', 'Simulator.app'))
  const hasDeviceHub = existsSync(join(developerDir, '..', 'Applications', 'DeviceHub.app'))
  if (hasSimulator || !hasDeviceHub)
    return { kind: 'unaffected' }

  const { capacitorCliVersion, nativeRunVersion, simulatorSource } = readNativeRun(projectDir)
  const versions = { capacitorCliVersion, nativeRunVersion }
  // Also recognize the upstream workaround applied with a package-manager patch.
  if (simulatorSource?.includes('devices://device/open'))
    return { kind: 'supported', ...versions }

  if (nativeRunVersion && canParse(nativeRunVersion) && !greaterThan(parse(nativeRunVersion), parse(LAST_UNSUPPORTED_NATIVE_RUN_VERSION)))
    return { kind: 'unsupported', ...versions }

  // Do not invent a first fixed release or assume future versions contain the fix.
  return { kind: 'unknown', ...versions }
}

export function formatIosSimulatorGuidance(compatibility: Exclude<IosSimulatorCompatibility, { kind: 'unaffected' }>): string {
  return [
    'The selected Xcode uses Device Hub instead of Simulator.app.',
    `Installed @capacitor/cli: ${compatibility.capacitorCliVersion ?? 'unknown'}; native-run used by Capacitor: ${compatibility.nativeRunVersion ?? 'unknown'}.`,
    compatibility.kind === 'unsupported'
      ? `native-run ${compatibility.nativeRunVersion} cannot launch simulators with this Xcode.`
      : 'Device Hub support could not be verified in the installed native-run.',
    'As of 2026-10-29, native-run 2.0.3 is the latest published release and the Device Hub fix is merged but unreleased. There is no released minimum Capacitor version for this fix yet.',
    'For now, run `npx cap open ios`, select your simulator in Xcode, then choose Product > Run. Confirm the baseline app opens before continuing OTA onboarding.',
    'Alternatively, use a physical iPhone/iPad or select an older installed Xcode that includes Simulator.app.',
    'For a package-manager patch, follow the upstream workaround. After the fixed native-run is released, update the dependency resolved by @capacitor/cli and your lockfile, then re-run `npx @capgo/cli@latest doctor`. Keep @capacitor/core, @capacitor/ios, @capacitor/android and @capacitor/cli on the same major; do not upgrade majors just to fix simulator launching.',
    `Upstream status and patch: ${IOS_SIMULATOR_ISSUE_URL}`,
  ].join('\n')
}
