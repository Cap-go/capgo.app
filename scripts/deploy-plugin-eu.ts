import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type WranglerRunner = (args: string[], env: NodeJS.ProcessEnv) => void

export function deployPluginEu(run: WranglerRunner = (args, env) => {
  execFileSync('bunx', ['wrangler', ...args], { stdio: 'inherit', env })
}) {
  const directory = mkdtempSync(join(tmpdir(), 'capgo-plugin-deploy-'))
  const output = join(directory, 'upload.jsonl')
  const config = ['--config', 'cloudflare_workers/plugin/wrangler.jsonc', '--env=prod_eu']
  try {
    run(['versions', 'upload', ...config, '--minify'], { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output })
    const records = readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const uploaded = records.find(record => record.type === 'version-upload' && record.worker_name === 'capgo_plugin-eu-prod')
    if (typeof uploaded?.version_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uploaded.version_id))
      throw new Error('Worker upload did not return a valid Version ID; refusing to deploy another version.')
    // Version deployment preserves routes managed by the custom-domain API.
    run(['versions', 'deploy', `${uploaded.version_id}@100`, ...config, '--yes'], process.env)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main)
  deployPluginEu()
