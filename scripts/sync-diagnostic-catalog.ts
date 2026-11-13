import { readFile, writeFile } from 'node:fs/promises'

// Run against a website checkout after editing the updater debugging guide.
// bun scripts/sync-diagnostic-catalog.ts /absolute/path/to/website
const website = process.argv[2]
if (!website)
  throw new Error('Pass the absolute path to a Cap-go/website checkout')
const source = await readFile(`${website}/apps/docs/src/content/docs/docs/plugins/updater/debugging.mdx`, 'utf8')
const normal = new Set(['ping', 'get', 'set', 'reset', 'delete', 'noNew', 'download_complete', 'download_manifest_start', 'download_manifest_complete', 'download_zip_start', 'download_zip_complete', 'app_moved_to_background', 'app_moved_to_foreground', 'os_version_changed', 'native_app_version_changed', 'getChannel', 'setChannel', 'uninstall', 'set_next', 'app_launch_start', 'app_launch_ready', 'webview_dom_content_loaded', 'webview_page_loaded', 'app_nav'])
const policy = new Set(['provider_infrastructure_request_blocked', 'InvalidIp', 'cannotUpdateViaPrivateChannel', 'customIdBlocked', 'channelPaused'])
const clean = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replaceAll('`', '').trim()
const entries = [...source.matchAll(/^### `([^`]+)`\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)].flatMap((match) => {
  const code = match[1]
  const parts = match[2].split(/\*\*What (?:it means|to do)\*\*/)
  if (!parts[1])
    return []
  const classification = normal.has(code) || /^download_\d+$/.test(code) ? 'normal' : code.startsWith('disable') || policy.has(code) ? 'policy' : 'error'
  return [[code, {
    classification,
    meaning: clean(parts[1]),
    next_steps: parts[2]?.trim() ? [clean(parts[2])] : classification === 'normal' ? [] : ['Inspect event metadata and device logs before changing configuration.'],
    docs_url: `https://capgo.app/docs/plugins/updater/debugging/#${code.toLowerCase()}`,
  }]]
})
await writeFile(new URL('../supabase/functions/_backend/utils/diagnosticCatalog.json', import.meta.url), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`)
