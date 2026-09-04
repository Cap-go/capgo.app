import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  getBundleUploadFailureRecoveryOptions,
  joinUniqueUploadPaths,
  MONOREPO_ROOT_PATHS_NOTE,
  MONOREPO_UPLOAD_RETRY_HINT,
  resolveUploadPaths,
  withMonorepoUploadRetryHint,
} from '../src/init/upload-recovery.ts'

const command = readFileSync(fileURLToPath(new URL('../src/init/command.ts', import.meta.url)), 'utf8')

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

assert.equal(withMonorepoUploadRetryHint(''), MONOREPO_UPLOAD_RETRY_HINT)
assert.equal(
  withMonorepoUploadRetryHint('Missing dependencies or invalid dependencies'),
  `Missing dependencies or invalid dependencies\n${MONOREPO_UPLOAD_RETRY_HINT}`,
)
assert.equal(
  withMonorepoUploadRetryHint(`already hinted\n${MONOREPO_UPLOAD_RETRY_HINT}`),
  `already hinted\n${MONOREPO_UPLOAD_RETRY_HINT}`,
)

assert.match(command, /getBundleUploadFailureRecoveryOptions/)
assert.match(command, /retry-with-monorepo-paths/)
assert.match(command, /Monorepo root package\.json path:/)
assert.match(command, /Monorepo root node_modules path:/)
assert.match(command, /promptForMonorepoRootUploadPaths/)
assert.match(command, /resolveUploadPaths\(packageJson, promptCwd\)/)
assert.match(command, /joinUniqueUploadPaths\(resolveUploadPaths\(packageJson, promptCwd\), currentPackageJson\)/)
assert.match(command, /joinUniqueUploadPaths\(resolveUploadPaths\(nodeModules, promptCwd\), currentNodeModules\)/)
assert.match(command, /globalUploadPackageJsonPath/)
assert.match(command, /packageJson: uploadPackageJsonPath/)
assert.match(command, /nodeModules: nodeModulesPath/)
assert.doesNotMatch(command, /packageJson: isMonorepo \? selectedPackageJsonPath/)

console.log('✅ init upload monorepo recovery tests passed')
