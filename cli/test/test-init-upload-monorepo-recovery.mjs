import assert from 'node:assert/strict'
import { shellQuotePath } from '../src/app/info.ts'
import {
  formatBundleUploadRunnerCommand,
  getBundleUploadFailureRecoveryOptions,
  joinUniqueUploadPaths,
  mergeMonorepoRootUploadPaths,
  MONOREPO_ROOT_PATHS_NOTE,
  MONOREPO_UPLOAD_RETRY_HINT,
  resolveUploadPaths,
  withMonorepoUploadRetryHint,
} from '../src/init/upload-recovery.ts'

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

assert.match(MONOREPO_ROOT_PATHS_NOTE, /monorepo\/workspace root/)
assert.match(MONOREPO_ROOT_PATHS_NOTE, /not the app package/)
assert.match(MONOREPO_UPLOAD_RETRY_HINT, /monorepo root package\.json/)
assert.match(MONOREPO_UPLOAD_RETRY_HINT, /monorepo root node_modules/)

const options = getBundleUploadFailureRecoveryOptions()
assert.deepEqual(options.map(option => option.value), ['retry', 'retry-with-monorepo-paths'])
assert.match(options[1].label, /monorepo root package\.json and node_modules/)
assert.match(options[1].hint ?? '', /Workspace root/)

assert.equal(joinUniqueUploadPaths(), undefined)
assert.equal(joinUniqueUploadPaths(''), undefined)
assert.equal(joinUniqueUploadPaths('/app/package.json', '/root/package.json'), '/app/package.json,/root/package.json')
assert.equal(joinUniqueUploadPaths('/root/package.json', '/root/package.json'), '/root/package.json')
assert.equal(joinUniqueUploadPaths('/app/package.json,/root/package.json', '/root/package.json'), '/app/package.json,/root/package.json')
assert.equal(joinUniqueUploadPaths(undefined, ' ./node_modules , /root/node_modules '), './node_modules,/root/node_modules')

const promptCwd = '/workspace/app'
assert.equal(resolveUploadPaths(undefined, promptCwd), undefined)
assert.equal(resolveUploadPaths('./package.json', promptCwd), '/workspace/app/package.json')
assert.equal(resolveUploadPaths('./package.json,./apps/mobile/package.json', promptCwd), '/workspace/app/package.json,/workspace/app/apps/mobile/package.json')
assert.equal(resolveUploadPaths('/already/absolute/package.json', promptCwd), '/already/absolute/package.json')
assert.equal(resolveUploadPaths('./node_modules', promptCwd), '/workspace/app/node_modules')

const packageJson = '/Users/a/My Project/package.json'
const nodeModules = '/Users/a/My Project/node_modules'
assert.equal(shellQuotePath(packageJson, 'linux'), '\'/Users/a/My Project/package.json\'')
assert.equal(shellQuotePath(packageJson, 'win32'), '"/Users/a/My Project/package.json"')
assert.equal(shellQuotePath(nodeModules, 'linux'), '\'/Users/a/My Project/node_modules\'')
assert.equal(shellQuotePath(nodeModules, 'win32'), '"/Users/a/My Project/node_modules"')

const uploadCommand = formatBundleUploadRunnerCommand('npx -y', 'com.example.app', {
  bundle: '1.0.1',
  channel: 'production',
  packageJson,
  nodeModules,
})
assert.match(uploadCommand, new RegExp(`--package-json ${escapeRegExp(shellQuotePath(packageJson))}`))
assert.match(uploadCommand, new RegExp(`--node-modules ${escapeRegExp(shellQuotePath(nodeModules))}`))

assert.equal(withMonorepoUploadRetryHint(''), MONOREPO_UPLOAD_RETRY_HINT)
assert.equal(
  withMonorepoUploadRetryHint('Missing dependencies or invalid dependencies'),
  `Missing dependencies or invalid dependencies\n${MONOREPO_UPLOAD_RETRY_HINT}`,
)
assert.equal(
  withMonorepoUploadRetryHint(`already hinted\n${MONOREPO_UPLOAD_RETRY_HINT}`),
  `already hinted\n${MONOREPO_UPLOAD_RETRY_HINT}`,
)

assert.deepEqual(
  mergeMonorepoRootUploadPaths(
    { packageJson: './package.json', nodeModules: './node_modules' },
    { packageJson: './apps/mobile/package.json', nodeModules: './apps/mobile/node_modules' },
    promptCwd,
  ),
  {
    packageJson: '/workspace/app/package.json,/workspace/app/apps/mobile/package.json',
    nodeModules: '/workspace/app/node_modules,/workspace/app/apps/mobile/node_modules',
  },
)
assert.deepEqual(
  mergeMonorepoRootUploadPaths(
    { packageJson: '/root/package.json', nodeModules: '/root/node_modules' },
    { packageJson: '/root/package.json', nodeModules: '/root/node_modules' },
    promptCwd,
  ),
  {
    packageJson: '/root/package.json',
    nodeModules: '/root/node_modules',
  },
)
assert.deepEqual(
  mergeMonorepoRootUploadPaths(
    { packageJson: './package.json', nodeModules: undefined },
    { packageJson: undefined, nodeModules: './node_modules' },
    promptCwd,
  ),
  {
    packageJson: '/workspace/app/package.json',
    nodeModules: '/workspace/app/node_modules',
  },
)

console.log('✅ init upload monorepo recovery tests passed')
