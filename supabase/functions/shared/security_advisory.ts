export type AdvisorySeverity = 'low' | 'moderate' | 'high' | 'critical'

export type AdvisoryMatchStatus = 'affected' | 'patched' | 'unknown'

export interface AdvisoryAffected {
  package: string
  affected_range: string
  patched_version: string | null
  capacitor_plus_version?: string
}

export interface Advisory {
  id: string
  ghsa_id: string
  cve_id?: string
  title: string
  severity: AdvisorySeverity
  affected: AdvisoryAffected[]
  fix_steps: string
  published_at: string
  url: string
  plus_release_url?: string
}

export interface AdvisoryFeed {
  advisories: Advisory[]
  generated_at: string
}

export interface AppAdvisoryMatch {
  package: string
  current_version: string
  advisory: Advisory
  affected: AdvisoryAffected
  status: AdvisoryMatchStatus
}

export interface AppAdvisoryFeedResponse {
  app_id: string
  feed: AdvisoryFeed
  items: AppAdvisoryMatch[]
}
