// Stamp the release version into both npm manifests and copy the signed,
// stapled .app bundles into their package dirs. Each per-arch package ships
// TWO bundles: the keychain helper (CapgoKeychainHelper.app, per-arch) and the
// App Store Connect key helper (CapgoAscKeyHelper.app, universal — the same
// bundle is copied into both arch packages).
//   Usage: node cli-helper/scripts/prepare-publish.mjs <semver>
// The <semver> MUST match the version baked into the keychain bundle's
// Info.plist by build.sh (we assert it) so the published package version, the
// npm tarball, and the bundle's CFBundleShortVersionString all agree. Fails
// fast on a malformed version or a missing bundle so a bad tag can never publish.
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The universal ASC key helper bundle is built by
// cli/scripts/package-asc-key-helper-app.sh into cli/dist-helper/.
const ascKeyAppSrc = join(root, '..', 'cli', 'dist-helper', 'CapgoAscKeyHelper.app')
const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`Usage: node prepare-publish.mjs <semver> — got "${version ?? ''}"`)
  process.exit(1)
}

// The ASC key helper bundle is shared (universal) across both arch packages.
const ascKeyInnerExec = join(ascKeyAppSrc, 'Contents', 'MacOS', 'CapgoAscKeyHelper')
if (!existsSync(ascKeyInnerExec)) {
  console.error(`Missing ASC key helper bundle ${ascKeyAppSrc} — run cli/scripts/package-asc-key-helper-app.sh + sign it first`)
  process.exit(1)
}

for (const arch of ['arm64', 'x64']) {
  const src = join(root, 'dist', arch, 'CapgoKeychainHelper.app')
  const innerExec = join(src, 'Contents', 'MacOS', 'capgo')
  if (!existsSync(innerExec)) {
    console.error(`Missing bundle ${src} — run build.sh + sign-and-notarize.sh first`)
    process.exit(1)
  }
  // Assert the bundle was built at this version (Info.plist is sealed, so this
  // also confirms we're shipping a bundle built for this exact release).
  const plist = readFileSync(join(src, 'Contents', 'Info.plist'), 'utf-8')
  if (!plist.includes(`<string>${version}</string>`)) {
    console.error(`Bundle ${src} Info.plist version != ${version} — rebuild with build.sh ${version}`)
    process.exit(1)
  }

  const pkgDir = join(root, 'npm', `darwin-${arch}`)
  const manifestPath = join(pkgDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)

  // Keychain helper (per-arch).
  const dest = join(pkgDir, 'CapgoKeychainHelper.app')
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  chmodSync(join(dest, 'Contents', 'MacOS', 'capgo'), 0o755)

  // ASC key helper (universal — same bundle copied into both arch packages).
  const ascDest = join(pkgDir, 'CapgoAscKeyHelper.app')
  rmSync(ascDest, { recursive: true, force: true })
  cpSync(ascKeyAppSrc, ascDest, { recursive: true })
  chmodSync(join(ascDest, 'Contents', 'MacOS', 'CapgoAscKeyHelper'), 0o755)

  // Ship the repository AGPL-3.0 license text with each published package.
  cpSync(join(root, '..', 'LICENSE'), join(pkgDir, 'LICENSE'))

  console.log(`Prepared ${manifest.name}@${version} (keychain + ASC key helper)`)
}
