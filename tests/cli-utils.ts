import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cwd, env } from 'node:process'
import { BASE_URL, getEndpointUrl } from './test-utils'

// Helper to check if file/directory exists using promises
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

export const TEMP_DIR_NAME = 'temp_cli_test'
const ROOT_DIR = cwd()
export const BASE_PACKAGE_JSON = `{
  "name": "%APPID%",
  "version": "1.0.0",
  "description": "An Amazing Test App",
  "dependencies": %DEPENDENCIES%,
  "devDependencies": {
    "@capacitor/cli": "^7.0.0",
    "typescript": "^5.2.2"
  },
  "author": ""
}`
export const BASE_DEPENDENCIES = {
  '@capacitor/android': '^7.0.0',
  '@capacitor/core': '7.0.0',
  '@capgo/capacitor-updater': '7.30.0',
}
export const BASE_DEPENDENCIES_OLD = {
  '@capacitor/android': '^6.0.0',
  '@capacitor/core': '6.0.0',
  '@capgo/capacitor-updater': '6.14.17',
}

// Cache for prepared apps to avoid repeated setup
const preparedApps = new Set<string>()

export const tempFileFolder = (appId: string) => join(ROOT_DIR, TEMP_DIR_NAME, appId)

function generateDefaultJsonCliConfig(appId: string) {
  return {
    appId,
    appName: 'demoApp',
    webDir: 'dist',
    plugins: {
      CapacitorUpdater: {
        autoUpdate: true,
        statsUrl: getEndpointUrl('/stats'),
        channelUrl: getEndpointUrl('/channel_self'),
        updateUrl: getEndpointUrl('/updates'),
        localS3: true,
        localHost: 'http://localhost:5173',
        localWebHost: 'http://localhost:5173',
        localApi: `${env.SUPABASE_URL}/functions/v1`,
        localApiFiles: BASE_URL,
      },
    },
  }
}

function generateCliConfig(appId: string): string {
  return `import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = ${JSON.stringify(generateDefaultJsonCliConfig(appId), null, 2)};

export default config;\n`
}

export async function setDependencies(dependencies: Record<string, string>, appId: string) {
  // write package.json
  const pathPack = join(tempFileFolder(appId), 'package.json')
  const res = BASE_PACKAGE_JSON.replace('%APPID%', appId).replace('%DEPENDENCIES%', JSON.stringify(dependencies, null, 2))
  await writeFile(pathPack, res)
}

export async function deleteTempFolders(appId: string) {
  const tempFolder = tempFileFolder(appId)
  if (await exists(tempFolder)) {
    // console.log('Deleting temp folder', tempFolder)
    await rm(tempFolder, { recursive: true, force: true })
  }
  preparedApps.delete(appId)
}

export function getSemver(semver = `1.0.${Date.now()}`) {
  const lastNumber = Number.parseInt(semver.charAt(semver.length - 1))
  const newSemver = `${semver.slice(0, -1)}${(lastNumber + 1).toString()}`
  return newSemver
}

export async function prepareCli(appId: string, old = false, installDeps = false) {
  // Skip if already prepared
  if (preparedApps.has(appId)) {
    return
  }

  const tempFolder = tempFileFolder(appId)
  const defaultConfig = generateCliConfig(appId)

  await deleteTempFolders(appId)

  // Create all directories and files in parallel for better performance
  const distPath = join(tempFolder, 'dist')
  const nodeModulesPath = join(tempFolder, 'node_modules')
  const capacitorConfigPath = join(tempFolder, 'capacitor.config.ts')

  // Create directories
  await mkdir(distPath, { recursive: true })

  // Write all files in parallel
  await Promise.all([
    writeFile(capacitorConfigPath, defaultConfig),
    writeFile(join(distPath, 'index.js'), 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\';\nconsole.log("Hello world!!!");\nCapacitorUpdater.notifyAppReady();'),
    writeFile(join(distPath, 'index.html'), ''),
  ])

  // Create package.json
  await setDependencies(old ? BASE_DEPENDENCIES_OLD : BASE_DEPENDENCIES, appId)

  if (installDeps) {
    // Only install dependencies for tests that specifically need them (like metadata tests)
    await npmInstallMinimal(appId)
  }
  else {
    const rootNodeModulesPath = join(ROOT_DIR, 'node_modules')

    try {
      await access(rootNodeModulesPath)
      // Replace with symlink to root node_modules so metadata checks can resolve deps.
      await rm(nodeModulesPath, { recursive: true, force: true })
      await symlink(rootNodeModulesPath, nodeModulesPath, 'dir')
    }
    catch {
      // Fallback to empty node_modules folder to satisfy CLI checks without installing
      await mkdir(nodeModulesPath, { recursive: true })

      // Create a minimal package.json in node_modules to indicate it's "installed"
      await writeFile(join(nodeModulesPath, '.package-lock.json'), '{"name": "temp", "lockfileVersion": 1}')
    }
  }

  preparedApps.add(appId)
}

// Minimal install that only gets essential dependencies
async function npmInstallMinimal(appId: string) {
  try {
    // Use exec with callback-based approach (no promisify as per user requirement)
    const { exec } = await import('node:child_process')

    // First try bun install
    await new Promise<void>((resolve, reject) => {
      exec('bun install', {
        cwd: tempFileFolder(appId),
        timeout: 60000,
      }, (error) => {
        if (error)
          reject(error)
        else
          resolve()
      })
    })
  }
  catch (error) {
    console.error(`bun install failed for ${appId}, trying npm:`, error)

    try {
      const { exec } = await import('node:child_process')

      // Fallback to npm
      await new Promise<void>((resolve, reject) => {
        exec('npm install --silent --no-audit --no-fund', {
          cwd: tempFileFolder(appId),
          timeout: 60000,
        }, (error) => {
          if (error)
            reject(error)
          else
            resolve()
        })
      })
    }
    catch (npmError) {
      console.error(`Both bun and npm install failed for ${appId}:`, npmError)
      // Create fake node_modules as fallback
      const nodeModulesPath = join(tempFileFolder(appId), 'node_modules')
      await mkdir(nodeModulesPath, { recursive: true })
      await writeFile(join(nodeModulesPath, '.package-lock.json'), '{"name": "temp", "lockfileVersion": 1}')
      throw npmError
    }
  }
}

// cleanup CLI
export async function cleanupCli(appId: string) {
  await deleteTempFolders(appId)
}
