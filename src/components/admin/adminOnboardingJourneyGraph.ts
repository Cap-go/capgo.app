export type AdminOnboardingJourneyNodeKind = 'stage' | 'event'
export type AdminOnboardingJourneyNodeTone = 'default' | 'success' | 'danger' | 'muted'
export type AdminOnboardingJourneyEdgeStyle = 'primary' | 'branch' | 'dotted'

export type AdminOnboardingJourneyIcon
  = | 'app'
    | 'close'
    | 'details'
    | 'failure'
    | 'file'
    | 'icon'
    | 'import'
    | 'intent'
    | 'link'
    | 'organization'
    | 'setup'
    | 'success'
    | 'upload'

export interface AdminOnboardingJourneyNode {
  id: string
  label: string
  count: number
  totalPercent?: number
  parentPercent?: number
  levelPercent?: number
  previousPercent?: number
  levelLabel?: string
  x: number
  y: number
  kind: AdminOnboardingJourneyNodeKind
  icon: AdminOnboardingJourneyIcon
  tone?: AdminOnboardingJourneyNodeTone
  width?: number
}

export interface AdminOnboardingJourneyEdge {
  from?: string
  to?: string
  fromPoint?: AdminOnboardingJourneyPoint
  toPoint?: AdminOnboardingJourneyPoint
  style: AdminOnboardingJourneyEdgeStyle
  arrow?: boolean
}

export interface AdminOnboardingJourneyPoint {
  x: number
  y: number
}

export interface AdminOnboardingJourneyLevel {
  label: string
  start: number
  end: number
  divider?: number
}

export interface AdminOnboardingJourneyGraphConfig {
  width: number
  height: number
  nodes: AdminOnboardingJourneyNode[]
  edges: AdminOnboardingJourneyEdge[]
  levels: AdminOnboardingJourneyLevel[]
  formatters: {
    levelPercent: (percent: number, level: string) => string
    totalPercent: (percent: number) => string
    previousPercent: (percent: number) => string
    parentPercent: (percent: number) => string
  }
}
