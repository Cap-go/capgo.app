import catalog from './diagnosticCatalog.json' with { type: 'json' }

const docsUrl = 'https://capgo.app/docs/plugins/updater/debugging/'

const aliases: Record<string, string> = {
  no_new_version_available: 'noNew', need_plan_upgrade: 'needPlanUpgrade',
  rate_limit_reached: 'rateLimited', no_channel_or_override: 'NoChannelOrOverride', channel_paused: 'channelPaused',
}
const normalizeCode = (code: string) => code.replace(/[^a-z0-9]/gi, '').toLowerCase()
const entriesByCode = new Map(Object.entries(catalog).map(([code, entry]) => [normalizeCode(code), entry]))

function catalogEntry(code: string) {
  return entriesByCode.get(normalizeCode(aliases[code] ?? code))
}

/** Explanations are a snapshot of our published docs, not a diagnosis of a particular device. */
export function explainDiagnostic(action: string, metadata?: Record<string, string> | null) {
  const code = action === 'backend_refusal'
    ? metadata?.error ?? metadata?.error_code ?? metadata?.code ?? action
    : action
  const entry = catalogEntry(code)
  if (entry) {
    return {
      code,
      ...entry,
      evidence: 'documented_event_meaning',
      requires_action: entry.classification !== 'normal',
    }
  }
  return {
    code,
    classification: 'unknown',
    meaning: 'This event has no documented explanation in this catalog. Its name alone does not establish a cause or severity.',
    next_steps: ['Inspect the event metadata and surrounding device timeline. Search the Capgo docs for this exact code; collect native logs if the cause remains unclear.'],
    docs_url: docsUrl,
    evidence: 'unclassified_event',
    requires_action: null,
  }
}
