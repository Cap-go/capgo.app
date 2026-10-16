import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const iosProject = new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)
const appPackage = new URL('../ios/App/CapApp-SPM/Package.swift', import.meta.url)
const supabasePackage = new URL('../node_modules/@capgo/capacitor-supabase/Package.swift', import.meta.url)

async function minimumPackageIosVersion(path: URL): Promise<number> {
  const source = await readFile(path, 'utf8')
  const version = source.match(/\.iOS\(\.v(\d+)(?:_(\d+))?\)/)
  if (!version)
    throw new Error(`Missing iOS platform declaration in ${path.pathname}`)
  return Number(`${version[1]}.${version[2] ?? '0'}`)
}

describe('native iOS platform compatibility', () => {
  it('keeps every Xcode configuration compatible with the installed Supabase plugin', async () => {
    const source = await readFile(iosProject, 'utf8')
    const deploymentTargets = [...source.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)]
    expect(deploymentTargets.length).toBeGreaterThan(0)

    const pluginMinimum = await minimumPackageIosVersion(supabasePackage)
    for (const [, target] of deploymentTargets)
      expect(Number(target), 'Capacitor generates SwiftPM platforms from the Xcode deployment target').toBeGreaterThanOrEqual(pluginMinimum)
  })

  it('keeps the checked-in Swift package compatible with the installed Supabase plugin', async () => {
    expect(await minimumPackageIosVersion(appPackage)).toBeGreaterThanOrEqual(await minimumPackageIosVersion(supabasePackage))
  })
})
