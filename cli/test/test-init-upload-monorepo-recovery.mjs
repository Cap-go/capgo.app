import assert from 'node:assert/strict'
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

assert.match(
  formatBundleUploadRunnerCommand('npx -y', 'com.example.app', {
    bundle: '1.0.1',
    channel: 'production',
    packageJson: '/Users/a/My Project/package.json',
    nodeModules: '/Users/a/My Project/node_modules',
  }),
  /--package-json '\/Users\/a\/My Project\/package\.json'/,
)
assert.match(
  formatBundleUploadRunnerCommand('npx -y', 'com.example.app', {
    bundle: '1.0.1',
    channel: 'production',
    packageJson: '/Users/a/My Project/package.json',
    nodeModules: '/Users/a/My Project/node_modules',
  }),
  /--node-modules '\/Users\/a\/My Project\/node_modules'/,
)

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
