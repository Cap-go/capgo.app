// Typed boundary around `@capacitor/cli` deep subpath imports.
//
// `@capacitor/cli` ships no type declarations for `dist/config` or
// `dist/util/monorepotools`. These were previously typed via an ambient
// `declare module` file, but an ambient declaration is only honored when the
// module does not otherwise resolve — which is environment dependent (it
// passes locally but fails under CI's `tsgo`, where the package is installed
// and resolves to the untyped `.js`, yielding TS7016 on every PR touching
// `cli/`). Centralizing the untyped imports here keeps the rest of the CLI
// fully typed while the bundler still resolves the real package at runtime.
import type { CapacitorConfig } from './schemas/config'
// @ts-expect-error `@capacitor/cli/dist/config` ships no type declarations
import { loadConfig as loadConfigUntyped, writeConfig as writeConfigUntyped } from '@capacitor/cli/dist/config'
// @ts-expect-error `@capacitor/cli/dist/util/monorepotools` ships no type declarations
import { findMonorepoRoot as findMonorepoRootUntyped, findNXMonorepoRoot as findNXMonorepoRootUntyped, isMonorepo as isMonorepoUntyped, isNXMonorepo as isNXMonorepoUntyped } from '@capacitor/cli/dist/util/monorepotools'
// @ts-expect-error `@capacitor/cli/dist/util/node` ships no type declarations
import { requireTS as requireTSUntyped } from '@capacitor/cli/dist/util/node'

export interface CapacitorCliConfig {
  app: {
    extConfig: CapacitorConfig
    extConfigFilePath: string
  }
}

export const requireTS: (typescript: unknown, filePath: string) => Record<string, unknown> = requireTSUntyped
export const loadConfig: () => Promise<CapacitorCliConfig> = loadConfigUntyped
export const writeConfig: (extConfig: CapacitorConfig, extConfigFilePath: string) => Promise<void> = writeConfigUntyped
export const findMonorepoRoot: (currentPath: string) => string = findMonorepoRootUntyped
export const findNXMonorepoRoot: (currentPath: string) => string = findNXMonorepoRootUntyped
export const isMonorepo: (currentPath: string) => boolean = isMonorepoUntyped
export const isNXMonorepo: (currentPath: string) => boolean = isNXMonorepoUntyped
