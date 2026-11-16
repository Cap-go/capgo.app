import process from 'node:process'
import { buildSnippets } from './build-snippets.ts'
import { loadProductionCustomDomains } from './custom-domains.ts'
import { deploySnippets } from './deploy-snippets.ts'

try {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--apply'))
    throw new Error('Usage: bun scripts/snippet/run-deployment.ts [--apply] (read-only by default)')
  const domains = await loadProductionCustomDomains({ token: process.env.SUPABASE_ACCESS_TOKEN ?? '' })
  await deploySnippets({ token: process.env.CLOUDFLARE_API_TOKEN ?? '', snippets: await buildSnippets(), customDomains: domains, apply: args.includes('--apply') })
}
catch (error) {
  console.error(error instanceof Error ? error.message : 'Snippet deployment failed')
  process.exitCode = 1
}
