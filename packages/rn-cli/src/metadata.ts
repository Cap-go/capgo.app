import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, parse, relative } from 'node:path'

const PACKNAME = 'package.json'
// eslint-disable-next-line regexp/no-unused-capturing-group
const nativeFileRegex = /([A-Za-z0-9]+)\.(java|swift|kt|scala|m|mm|cpp|c|h)$/

export interface ReactNativeDependency {
  name: string
  version: string
  requested_version: string
  native: boolean
  ios_checksum?: string
  android_checksum?: string
}

export interface ReactNativeNativePackage {
  name: string
  version: string
  requested_version?: string
  ios_checksum?: string
  android_checksum?: string
}

function getHoistedNodeModulesPaths(startDir: string): string[] {
  const paths: string[] = []
  let currentDir = startDir
  const root = parse(currentDir).root
  while (true) {
    paths.push(join(currentDir, 'node_modules'))
    if (currentDir === root)
      break
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir)
      break
    currentDir = parentDir
  }
  return paths
}

function readDirRecursively(dir: string): string[] {
  const entries: string[] = []
  if (!existsSync(dir))
    return entries
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory())
      entries.push(...readDirRecursively(fullPath))
    else
      entries.push(fullPath)
  }
  return entries
}

function readDirRecursivelyFullPaths(dir: string): string[] {
  return readDirRecursively(dir)
}

function packageDeclaresReactNativeNative(packageJson: unknown): boolean {
  if (typeof packageJson !== 'object' || packageJson === null)
    return false
  const pkg = packageJson as Record<string, unknown>
  if (pkg.codegenConfig !== undefined)
    return true
  if (typeof pkg.reactNative === 'object' && pkg.reactNative !== null)
    return true
  return false
}

export function dependencyDeclaresReactNativeNative(dependencyFolderPath: string): boolean {
  if (existsSync(join(dependencyFolderPath, 'react-native.config.js')))
    return true
  if (existsSync(join(dependencyFolderPath, 'react-native.config.ts')))
    return true
  if (existsSync(join(dependencyFolderPath, 'react-native.config.cjs')))
    return true

  try {
    for (const file of readdirSync(dependencyFolderPath)) {
      if (file.endsWith('.podspec'))
        return true
    }
  }
  catch {
    // ignore
  }

  const packageJsonPath = join(dependencyFolderPath, PACKNAME)
  if (existsSync(packageJsonPath)) {
    try {
      if (packageDeclaresReactNativeNative(JSON.parse(readFileSync(packageJsonPath, 'utf-8'))))
        return true
    }
    catch {
      // ignore
    }
  }

  const hasAndroid = existsSync(join(dependencyFolderPath, 'android', 'build.gradle'))
    || existsSync(join(dependencyFolderPath, 'android', 'build.gradle.kts'))
  const iosDir = join(dependencyFolderPath, 'ios')
  const hasIos = existsSync(iosDir) && readdirSync(iosDir).length > 0
  return hasAndroid || hasIos
}

function getPlatformConfigFiles(dependencyFolderPath: string, platform: 'ios' | 'android'): string[] {
  const files: string[] = []
  if (platform === 'ios') {
    try {
      for (const file of readdirSync(dependencyFolderPath)) {
        if (file.endsWith('.podspec'))
          files.push(join(dependencyFolderPath, file))
      }
    }
    catch {
      // ignore
    }
    const packageSwiftRoot = join(dependencyFolderPath, 'Package.swift')
    const packageSwiftIos = join(dependencyFolderPath, 'ios', 'Package.swift')
    if (existsSync(packageSwiftRoot))
      files.push(packageSwiftRoot)
    if (existsSync(packageSwiftIos))
      files.push(packageSwiftIos)
  }
  else {
    const buildGradle = join(dependencyFolderPath, 'android', 'build.gradle')
    const buildGradleKts = join(dependencyFolderPath, 'android', 'build.gradle.kts')
    if (existsSync(buildGradle))
      files.push(buildGradle)
    if (existsSync(buildGradleKts))
      files.push(buildGradleKts)
  }
  return files
}

async function calculatePlatformChecksums(dependencyFolderPath: string): Promise<{ ios_checksum?: string, android_checksum?: string }> {
  const iosDir = join(dependencyFolderPath, 'ios')
  const androidDir = join(dependencyFolderPath, 'android')

  const calculatePlatformChecksum = async (platformDir: string, platform: 'ios' | 'android'): Promise<string | undefined> => {
    const nativeFiles = existsSync(platformDir)
      ? readDirRecursivelyFullPaths(platformDir).filter(f => nativeFileRegex.test(f))
      : []
    const configFiles = getPlatformConfigFiles(dependencyFolderPath, platform)
    const allFiles = [...nativeFiles, ...configFiles].sort((a, b) => a.localeCompare(b))
    if (allFiles.length === 0)
      return undefined

    const hash = createHash('sha256')
    for (const file of allFiles) {
      try {
        hash.update(relative(dependencyFolderPath, file))
        hash.update(readFileSync(file))
      }
      catch {
        // skip unreadable files
      }
    }
    return hash.digest('hex')
  }

  const [ios_checksum, android_checksum] = await Promise.all([
    calculatePlatformChecksum(iosDir, 'ios'),
    calculatePlatformChecksum(androidDir, 'android'),
  ])
  return { ios_checksum, android_checksum }
}

function collectDeclaredDependencies(packageJsonPath: string): Map<string, string> {
  const dependencies = new Map<string, string>()
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (typeof version === 'string')
      dependencies.set(name, version)
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    if (typeof version === 'string')
      dependencies.set(name, version)
  }
  return dependencies
}

function resolveInstalledVersion(depName: string, packageDir: string, declaredVersion: string): string {
  try {
    const requireFromBase = createRequire(join(packageDir, PACKNAME))
    const resolvedPath = requireFromBase.resolve(`${depName}/${PACKNAME}`)
    const depPkg = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as { version?: string }
    if (depPkg.version)
      return depPkg.version
  }
  catch {
    // fall through
  }

  let currentDir = packageDir
  const root = parse(currentDir).root
  while (currentDir !== root) {
    const nodeModulesPath = join(currentDir, 'node_modules', depName, PACKNAME)
    if (existsSync(nodeModulesPath)) {
      try {
        const depPkg = JSON.parse(readFileSync(nodeModulesPath, 'utf-8')) as { version?: string }
        if (depPkg.version)
          return depPkg.version
      }
      catch {
        // ignore
      }
    }
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir)
      break
    currentDir = parentDir
  }
  return declaredVersion
}

export async function getReactNativeLocalDependencies(
  projectRoot: string,
  packageJsonPath?: string,
  nodeModulesPaths?: string[],
): Promise<ReactNativeDependency[]> {
  const pkgPath = packageJsonPath ?? join(projectRoot, PACKNAME)
  if (!existsSync(pkgPath))
    throw new Error(`No package.json found at ${pkgPath}`)

  const packageDir = dirname(pkgPath)
  const declared = collectDeclaredDependencies(pkgPath)
  const nodeModules = nodeModulesPaths?.length
    ? nodeModulesPaths
    : getHoistedNodeModulesPaths(packageDir)

  if (!nodeModules.some(path => existsSync(path)))
    throw new Error(`Missing node_modules near ${packageDir}. Run your package manager install first.`)

  const missing: string[] = []
  const results = await Promise.all([...declared.entries()].map(async ([name, requestedVersion]) => {
    let dependencyFound = false
    let hasNativeFiles = false
    let actualVersion = requestedVersion
    let foundDependencyPath: string | undefined

    for (const modulePath of nodeModules) {
      const dependencyFolderPath = join(modulePath, name)
      if (!existsSync(dependencyFolderPath))
        continue

      dependencyFound = true
      foundDependencyPath = dependencyFolderPath
      actualVersion = resolveInstalledVersion(name, packageDir, requestedVersion)

      if (!dependencyDeclaresReactNativeNative(dependencyFolderPath))
        continue

      const files = readDirRecursively(dependencyFolderPath)
      if (files.some(fileName => nativeFileRegex.test(fileName))) {
        hasNativeFiles = true
        break
      }
    }

    if (!dependencyFound)
      missing.push(name)

    let ios_checksum: string | undefined
    let android_checksum: string | undefined
    if (hasNativeFiles && foundDependencyPath) {
      const checksums = await calculatePlatformChecksums(foundDependencyPath)
      ios_checksum = checksums.ios_checksum
      android_checksum = checksums.android_checksum
    }

    return {
      name,
      version: actualVersion,
      requested_version: requestedVersion,
      native: hasNativeFiles,
      ios_checksum,
      android_checksum,
    }
  }))

  if (missing.length > 0)
    throw new Error(`Missing dependencies in node_modules: ${missing.join(', ')}`)

  return results
}

export function toNativePackages(dependencies: ReactNativeDependency[]): ReactNativeNativePackage[] {
  return dependencies
    .filter(dep => dep.native)
    .map(({ name, version, requested_version, ios_checksum, android_checksum }) => ({
      name,
      version,
      requested_version,
      ...(ios_checksum ? { ios_checksum } : {}),
      ...(android_checksum ? { android_checksum } : {}),
    }))
}
