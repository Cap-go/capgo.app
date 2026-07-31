import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'

export const CAPGO_UPDATER_PACKAGE = '@capgo/capacitor-updater'

type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies'

export interface UpdaterInstallState {
  packageJsonPath: string
  projectDir: string
  declaredVersion: string | null
  declaredIn: DependencySection | null
  installedVersion: string | null
  ready: boolean
  details: string[]
}

interface PackageJsonDependencies {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
}

function readPackageJson(packageJsonPath: string): PackageJsonDependencies | null {
  if (!existsSync(packageJsonPath))
    return null

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonDependencies
  }
  catch {
    return null
  }
}

function getDeclaredDependency(packageJsonPath: string, packageName: string) {
  const packageJson = readPackageJson(packageJsonPath)
  if (!packageJson)
    return { version: null, section: null }

  const sections: DependencySection[] = ['dependencies', 'devDependencies', 'optionalDependencies']
  for (const section of sections) {
    const dependencies = packageJson[section]
    if (!dependencies || !Object.hasOwn(dependencies, packageName))
      continue

    const version = dependencies[packageName]
    return {
      version: typeof version === 'string' ? version : String(version),
      section,
    }
  }

  return { version: null, section: null }
}

function readInstalledPackageVersion(packageJsonPath: string, packageName: string): string | null {
  const projectDir = dirname(packageJsonPath)

  let currentDir = projectDir
  while (true) {
    const packagePath = join(currentDir, 'node_modules', packageName, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: unknown }
        if (typeof packageJson.version === 'string')
          return packageJson.version
      }
      catch {
        return null
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir)
      break
    currentDir = parentDir
  }

  if (!process.versions.pnp)
    return null

  try {
    const requireFromProject = createRequire(packageJsonPath)
    const resolvedPackageJsonPath = requireFromProject.resolve(`${packageName}/package.json`)
    const packageJson = JSON.parse(readFileSync(resolvedPackageJsonPath, 'utf-8')) as { version?: unknown }
    if (typeof packageJson.version === 'string')
      return packageJson.version
  }
  catch {
    return null
  }

  return null
}

export function getUpdaterInstallState(packageJsonPath: string): UpdaterInstallState {
  const projectDir = dirname(packageJsonPath)
  const declaration = getDeclaredDependency(packageJsonPath, CAPGO_UPDATER_PACKAGE)
  const installedVersion = readInstalledPackageVersion(packageJsonPath, CAPGO_UPDATER_PACKAGE)
  const details: string[] = []

  if (!declaration.version)
    details.push(`Missing ${CAPGO_UPDATER_PACKAGE} in ${packageJsonPath}`)
  if (!installedVersion)
    details.push(`Cannot resolve ${CAPGO_UPDATER_PACKAGE} from ${projectDir}/node_modules`)

  return {
    packageJsonPath,
    projectDir,
    declaredVersion: declaration.version,
    declaredIn: declaration.section,
    installedVersion,
    ready: details.length === 0,
    details,
  }
}
