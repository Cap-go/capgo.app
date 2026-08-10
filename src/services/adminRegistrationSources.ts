export interface RegistrationSourceTrendPoint {
  date: string
  normal_registrations: number
  invite_registrations: number
  without_profile: number
}

export interface RegistrationSourceTotals {
  normalRegistrations: number
  organizationInvites: number
  withoutProfiles: number
}

export function aggregateRegistrationSourceTotals(trend: readonly RegistrationSourceTrendPoint[]): RegistrationSourceTotals {
  return trend.reduce((totals, item) => ({
    normalRegistrations: totals.normalRegistrations + (Number(item.normal_registrations) || 0),
    organizationInvites: totals.organizationInvites + (Number(item.invite_registrations) || 0),
    withoutProfiles: totals.withoutProfiles + (Number(item.without_profile) || 0),
  }), {
    normalRegistrations: 0,
    organizationInvites: 0,
    withoutProfiles: 0,
  })
}
