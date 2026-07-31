// src/build/onboarding/android/android-rename.ts
//
// Pure helpers for the Path A "Rename my Android project for me" convenience
// (explicit opt-in only). All I/O — mkdtemp, npm install, spawning node /
// `cap sync`, and `pgrep` — lives in the app.tsx orchestration; everything
// here is pure so it can be unit-tested without touching the filesystem or
// spawning processes.

/**
 * Pinned `@trapezedev/project` version installed on demand into the temp rename
 * workspace. Trapeze is NOT bundled with the CLI (keeps it lean) — it's only
 * installed when the user explicitly opts into the rename. Pinned so the rename
 * behavior is reproducible.
 */
export const TRAPEZE_PROJECT_VERSION = '7.1.4'

export interface RenameWorkspaceFiles {
  /** Contents of the temp `package.json` (`type: module` + pinned Trapeze). */
  packageJson: string
  /** Contents of the `rename.mjs` script run as `node rename.mjs <appId>`. */
  renameMjs: string
}

/**
 * Build the two files written into the temp rename workspace.
 *
 * The `rename.mjs` script runs the proven 3-call Trapeze sequence — ALWAYS all
 * three setters (`setPackageName` + `setApplicationId` + `setNamespace`).
 * Skipping `namespace` is not an option: AGP 8 requires it, and a package move
 * with a stale namespace breaks `R`/`BuildConfig` imports and fails the build.
 * The `appId` is read from `process.argv[2]` so the caller passes the target
 * package as a CLI argument rather than templating it into the script.
 *
 * `pkg` is accepted for symmetry / future validation but is intentionally NOT
 * interpolated into the script — the appId always flows in via argv at runtime,
 * which avoids any string-injection of an attacker-controlled package into the
 * generated JS.
 *
 * `androidDir` is the resolved native directory (from capacitor.config; it may be
 * a non-default path like `apps/mobile/platforms/android-native`). It is baked
 * into the MobileProject config JSON-escaped so the rename targets the CONFIGURED
 * native project, never a hardcoded `./android` (which could mutate a stale tree).
 */
export function buildRenameWorkspaceFiles(pkg: string, androidDir: string): RenameWorkspaceFiles {
  void pkg
  const packageJson = `${JSON.stringify(
    {
      name: 'capgo-android-rename',
      private: true,
      type: 'module',
      devDependencies: {
        '@trapezedev/project': TRAPEZE_PROJECT_VERSION,
      },
    },
    null,
    2,
  )}\n`

  const renameMjs = `import { MobileProject } from '@trapezedev/project'

const appId = process.argv[2]
if (!appId) {
  console.error('Usage: node rename.mjs <appId>')
  process.exit(1)
}

const project = new MobileProject('.', { android: { path: ${JSON.stringify(androidDir)} } })
await project.load()
await project.android?.setPackageName(appId)
const gradle = await project.android?.getGradleFile('app/build.gradle')
await gradle?.setApplicationId(appId)
await gradle?.setNamespace(appId)
await project.commit()
console.log(\`Renamed Android project to \${appId}\`)
`

  return { packageJson, renameMjs }
}

/** Whether Android Studio is holding the project's native files open. */
export type AndroidStudioState = 'running' | 'not-running' | 'unknown'

/**
 * Pure predicate for the close-Android-Studio gate. Editing native files while
 * Studio holds them open risks a half-written project / Studio clobbering the
 * change.
 *
 * Only macOS can be determined here: `pgrep -f "Android Studio"` is the source
 * of `pgrepOutput`, so a non-empty (trimmed) result means it's running and an
 * empty one means it's closed. On any other platform we can't reliably probe,
 * so the caller falls back to a one-time confirm → `unknown`.
 */
export function isAndroidStudioRunning(platform: string, pgrepOutput: string): AndroidStudioState {
  if (platform !== 'darwin')
    return 'unknown'
  return pgrepOutput.trim().length > 0 ? 'running' : 'not-running'
}

/**
 * Verify the rename landed: re-read Gradle ids (via `findAndroidApplicationIds`,
 * which returns `string[]`) and confirm the list now contains the target
 * package. Returns `false` so the caller surfaces output + a manual fallback
 * instead of claiming a false success.
 */
export function verifyRenamed(gradleIds: string[], target: string): boolean {
  return gradleIds.includes(target)
}
