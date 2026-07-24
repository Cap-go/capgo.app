import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { env, exit } from 'node:process'
// Precompiled helper packages (keychain + ASC key helper .apps) resolve from
// node_modules at runtime (binary-only optional deps) — never bundle them.
const HELPER_PACKAGES = [
  '@capgo/cli-helper-darwin-arm64',
  '@capgo/cli-helper-darwin-x64',
]

const EXTERNAL_PACKAGES = [
  ...HELPER_PACKAGES,
  'node-pty',
]

// Shared plugin definitions - Bun's plugin API is compatible with esbuild's
const stubSemver = {
  name: 'stub-semver',
  setup(build) {
    build.onResolve({ filter: /^semver$/ }, args => ({
      path: args.path,
      namespace: 'stub-semver',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub-semver' }, () => ({
      contents: `
        // Stub for semver package - @capacitor/cli requires it but checkPlatformVersions is never called
        export const diff = () => null;
        export const parse = () => null;
        export const valid = () => null;
        export const clean = () => null;
        export const inc = () => null;
        export const major = () => null;
        export const minor = () => null;
        export const patch = () => null;
        export const compare = () => 0;
        export const rcompare = () => 0;
        export const gt = () => false;
        export const lt = () => false;
        export const eq = () => false;
        export const neq = () => true;
        export const gte = () => false;
        export const lte = () => false;
        export const satisfies = () => false;
        export const maxSatisfying = () => null;
        export const minSatisfying = () => null;
        export const validRange = () => null;
        export const outside = () => false;
        export const gtr = () => false;
        export const ltr = () => false;
        export const intersects = () => false;
        export const coerce = () => null;
        export const Range = class Range {};
        export const SemVer = class SemVer {};
        export const Comparator = class Comparator {};
      `,
    }))
  },
}

const ignorePunycode = {
  name: 'ignore-punycode',
  setup(build) {
    build.onResolve({ filter: /^punycode$/ }, args => ({
      path: args.path,
      namespace: 'ignore',
    }))
    build.onLoad({ filter: /.*/, namespace: 'ignore' }, () => ({
      contents: 'export default {}',
    }))
  },
}

const noopXml2js = {
  name: 'noop-xml2js',
  setup(build) {
    build.onResolve({ filter: /^xml2js$/ }, args => ({
      path: args.path,
      namespace: 'noop',
    }))
    build.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({
      contents: 'export default {}',
    }))
  },
}

const noopIonicUtilsSubprocess = {
  name: 'noop-ionic-utils-subprocess',
  setup(build) {
    build.onResolve({ filter: /@ionic\/utils-subprocess/ }, args => ({
      path: args.path,
      namespace: 'noop',
    }))
    build.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({
      contents: 'export default {}',
    }))
  },
}

const smartNoopIonicCliFrameworkOutput = {
  name: 'smart-noop-ionic-cli-framework-output',
  setup(build) {
    build.onResolve({ filter: /@ionic\/cli-framework-output/ }, args => ({
      path: args.path,
      namespace: 'smart-noop-ionic-cli-framework-output',
    }))
    build.onLoad({ filter: /.*/, namespace: 'smart-noop-ionic-cli-framework-output' }, () => ({
      contents: `
        export const TTY_WIDTH = 80;
        export const indent = (str) => str;
        export const sliceAnsi = (str) => str;
        export const stringWidth = (str) => str.length;
        export const stripAnsi = (str) => str;
        export const wordWrap = (str) => str;
        export const createDefaultLogger = () => ({
          info: console.log,
          warn: console.warn,
          error: console.error,
          debug: console.debug,
        });
        export const NO_COLORS = {};
        export class StreamOutputStrategy {
          constructor() {
            this.colors = NO_COLORS;
            this.stream = process.stdout;
          }
        }
        export class TTYOutputStrategy extends StreamOutputStrategy {
          constructor(options) {
            super();
            this.options = options;
          }
        }
        export class Logger {
          constructor() {}
          info() {}
          warn() {}
          error() {}
          debug() {}
        }
        export const LOGGER_LEVELS = {
          DEBUG: 'DEBUG',
          INFO: 'INFO',
          WARN: 'WARN',
          ERROR: 'ERROR'
        };
      `,
    }))
  },
}

const noopSupabaseRealtimeJs = {
  name: 'noop-supabase-realtime-js',
  setup(build) {
    build.onResolve({ filter: /@supabase\/realtime-js/ }, args => ({
      path: args.path,
      namespace: 'noop-supabase-realtime-js',
    }))
    build.onLoad({ filter: /.*/, namespace: 'noop-supabase-realtime-js' }, () => ({
      contents: `
        export class RealtimeClient {
          constructor() {}
          connect() {}
          disconnect() {}
        }
      `,
    }))
  },
}

const stubPrompts = {
  name: 'stub-prompts',
  setup(build) {
    build.onResolve({ filter: /^prompts$/ }, args => ({
      path: args.path,
      namespace: 'stub-prompts',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub-prompts' }, () => ({
      contents: `
        // Stub for prompts package - @capacitor/cli requires it but we don't use it
        export default function prompts() {
          throw new Error('Prompts are not supported in this CLI build');
        }
      `,
    }))
  },
}

const noopSupabaseAuthJs = {
  name: 'noop-supabase-auth-js',
  setup(build) {
    build.onResolve({ filter: /@supabase\/auth-js/ }, args => ({
      path: args.path,
      namespace: 'noop-supabase-auth-js',
    }))
    build.onLoad({ filter: /.*/, namespace: 'noop-supabase-auth-js' }, () => ({
      contents: `
        // Stub for @supabase/auth-js - we don't use authentication, just API calls
        const noopAsync = () => Promise.resolve({ data: { session: null, user: null }, error: null });
        const noopHandler = {
          get: (target, prop) => {
            if (prop === 'constructor') return target.constructor;
            if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
            if (typeof prop === 'symbol') return undefined;
            // Return method that returns properly structured promises
            if (prop === 'getSession') return () => Promise.resolve({ data: { session: null, user: null }, error: null });
            if (prop === 'onAuthStateChange') return () => ({ data: { subscription: { unsubscribe: () => {} } }, error: null });
            return noopAsync;
          }
        };

        export class GoTrueClient {
          constructor(options) {
            this.options = options;
            return new Proxy(this, noopHandler);
          }
        }
        export class GoTrueAdminApi {
          constructor(options) {
            this.options = options;
            return new Proxy(this, noopHandler);
          }
        }
        export class AuthClient extends GoTrueClient {}
        export class AuthAdminApi extends GoTrueAdminApi {}

        // Export error classes
        export class AuthError extends Error {}
        export class AuthApiError extends AuthError {}
        export class AuthRetryableError extends AuthError {}
        export class AuthSessionMissingError extends AuthError {}
        export class AuthInvalidTokenResponseError extends AuthError {}
        export class AuthInvalidCredentialsError extends AuthError {}
        export class AuthImplicitGrantRedirectError extends AuthError {}
        export class AuthPKCEGrantCodeExchangeError extends AuthError {}
        export class AuthWeakPasswordError extends AuthError {}

        // Export helper functions
        export const navigatorLock = noopAsync;
        export const processLock = noopAsync;
        export class NavigatorLockAcquireTimeoutError extends Error {}
        export const lockInternals = {};

        // Export type helpers
        export const isAuthError = () => false;
        export const isAuthApiError = () => false;
        export const isAuthRetryableError = () => false;
        export const isAuthSessionMissingError = () => false;
        export const isAuthWeakPasswordError = () => false;
      `,
    }))
  },
}

const noopSupabaseNodeFetch = {
  name: 'noop-supabase-node-fetch',
  setup(build) {
    build.onResolve({ filter: /@supabase\/node-fetch/ }, args => ({
      path: args.path,
      namespace: 'noop',
    }))
    build.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({
      contents: 'export default {}',
    }))
  },
}

// Stub react-devtools-core — Ink optionally imports it for dev mode
const stubReactDevtools = {
  name: 'stub-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, args => ({
      path: args.path,
      namespace: 'stub-react-devtools',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub-react-devtools' }, () => ({
      contents: 'export default {}; export const connectToDevTools = () => {};',
    }))
  },
}

// Fix for @capacitor/cli path assumptions in bundled builds
// - __dirname gets baked in as the build machine path
// - loadCLIConfig reads package.json from cliRootDir
// We replace __dirname with import.meta.url and make package.json read resilient
// See: https://github.com/oven-sh/bun/issues/4216
const fixCapacitorCliDirname = {
  name: 'fix-capacitor-cli-dirname',
  setup(build) {
    // Allow matching when @capacitor/cli is hoisted, linked, or vendored.
    build.onLoad({ filter: /@capacitor[\\/]cli[\\/]dist[\\/]config\.js$/ }, async (args) => {
      const contents = readFileSync(args.path, 'utf-8')

      // Replace any __dirname usage (CJS) with runtime-safe import.meta.url resolution.
      // Keep this broad so it survives upstream refactors.
      let patched = contents.replace(
        /\b__dirname\b/g,
        "require('path').dirname(require('url').fileURLToPath(import.meta.url))"
      )

      // Make CLI package.json read resilient in bundled runtime.
      // Capture module alias names to avoid breaking if upstream renames them.
      patched = patched.replace(
        /package:\s*await\s*\(0,\s*([\w$]+)\.readJSON\)\(\(0,\s*([\w$]+)\.resolve\)\(rootDir,\s*'package\.json'\)\)\s*,/g,
        (_match, fsAlias, pathAlias) =>
          `package: await (0, ${fsAlias}.readJSON)((0, ${pathAlias}.resolve)(rootDir, 'package.json')).catch(() => ({ name: '@capacitor/cli', version: '0.0.0' })),`
      )

      return { contents: patched, loader: 'js' }
    })
  },
}

// Build CLI
const buildCLI = Bun.build({
  entrypoints: ['src/index.ts'],
  target: 'node',
  outdir: 'dist',
  external: EXTERNAL_PACKAGES,
  sourcemap: env.NODE_ENV === 'development' ? 'linked' : 'none',
  minify: true,
  // Keep env access runtime-only unless explicitly defined below.
  env: 'disable',
  define: {
    'process.env.SUPA_DB': '"production"',
    // __CAPGO_DEV__ stays false forever — dev/spoof branches never ship.
    'globalThis.__CAPGO_DEV__': 'false',
    // MCP onboarding is release-ready as of PR 2: ship the onboarding tools.
    'globalThis.__CAPGO_MCP_ONBOARDING__': 'true',
    'globalThis.__CAPGO_MCP_LIVE_UPDATE__': 'true',
    // Gates the CAPGO_KEYCHAIN_HELPER_PATH dev override. `false` here makes
    // the minifier delete the whole branch from release bundles —
    // publish_cli.yml asserts the string is absent from dist/index.js.
    '__CAPGO_ALLOW_HELPER_ENV_OVERRIDE__': env.NODE_ENV === 'development' ? 'true' : 'false',
  },
  plugins: [
    fixCapacitorCliDirname,
    stubSemver,
    ignorePunycode,
    noopXml2js,
    noopIonicUtilsSubprocess,
    smartNoopIonicCliFrameworkOutput,
    noopSupabaseRealtimeJs,
    stubPrompts,
    noopSupabaseAuthJs,
    stubReactDevtools,
  ],
})

// Build SDK (separate bundle without CLI dependencies)
const buildSDK = Bun.build({
  entrypoints: ['src/sdk.ts'],
  target: 'node',
  outdir: 'dist/src',
  naming: 'sdk.js',
  external: EXTERNAL_PACKAGES,
  minify: true,
  format: 'esm',
  // Keep env access runtime-only unless explicitly defined below.
  env: 'disable',
  define: {
    'process.env.SUPA_DB': '"production"',
    // __CAPGO_DEV__ stays false forever — dev/spoof branches never ship.
    'globalThis.__CAPGO_DEV__': 'false',
    // MCP onboarding is release-ready as of PR 2: ship the onboarding tools.
    'globalThis.__CAPGO_MCP_ONBOARDING__': 'true',
    'globalThis.__CAPGO_MCP_LIVE_UPDATE__': 'true',
    // Gates the CAPGO_KEYCHAIN_HELPER_PATH dev override. `false` here makes
    // the minifier delete the whole branch from release bundles —
    // publish_cli.yml asserts the string is absent from dist/index.js.
    '__CAPGO_ALLOW_HELPER_ENV_OVERRIDE__': env.NODE_ENV === 'development' ? 'true' : 'false',
  },
  plugins: [
    fixCapacitorCliDirname,
    ignorePunycode,
    noopSupabaseNodeFetch,
  ],
})

Promise.all([buildCLI, buildSDK]).then(async (results) => {
  const [cliResult, sdkResult] = results

  // Check for build errors
  if (!cliResult.success) {
    console.error('CLI build failed:')
    for (const log of cliResult.logs) {
      console.error(log)
    }
    exit(1)
  }

  if (!sdkResult.success) {
    console.error('SDK build failed:')
    for (const log of sdkResult.logs) {
      console.error(log)
    }
    exit(1)
  }

  // Add shebang to CLI bundle
  const cliOutput = await Bun.file('dist/index.js').text()
  await Bun.write('dist/index.js', `#!/usr/bin/env node\n${cliOutput}`)

  // Bun has occasionally emitted `module.exports` in ESM bundles.
  // Ensure the SDK bundle doesn't crash in ESM by providing a shim when needed.
  const sdkPath = 'dist/src/sdk.js'
  try {
    let sdkOutput = readFileSync(sdkPath, 'utf-8')
    const hasModuleBinding = /\b(?:var|let|const)\s+module(?![$\w])/.test(sdkOutput)
    if (/\bmodule\.exports\b/.test(sdkOutput) && !hasModuleBinding) {
      const importBlock = sdkOutput.match(/^(?:\s*import[^;]+;)+/)
      const insertAt = importBlock ? importBlock[0].length : 0
      sdkOutput = `${sdkOutput.slice(0, insertAt)}var module={exports:{}};${sdkOutput.slice(insertAt)}`
      writeFileSync(sdkPath, sdkOutput)
    }
  }
  catch (err) {
    console.warn('⚠️  Could not inspect SDK bundle for module shim:', err)
  }

  // Write metafile for bundle analysis (similar to esbuild's metafile)
  // Use relative paths to match esbuild's format
  const metafile = {
    inputs: {},
    outputs: {},
  }
  for (const output of cliResult.outputs) {
    const relativePath = output.path.replace(process.cwd() + '/', '')
    metafile.outputs[relativePath] = { bytes: output.size }
  }
  for (const output of sdkResult.outputs) {
    const relativePath = output.path.replace(process.cwd() + '/', '')
    metafile.outputs[relativePath] = { bytes: output.size }
  }
  writeFileSync('meta.json', JSON.stringify(metafile))

  copyFileSync('package.json', 'dist/package.json')

  console.warn('✅ Built CLI and SDK successfully')
}).catch((err) => {
  console.error('Build failed:', err)
  exit(1)
})
