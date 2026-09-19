import type { UserModule } from '~/types'

// v3 setup lives on /app/:app/getting-started (GettingStartedCliPanel). Main's
// redirect to /onboarding/app?step=setup is intentionally not installed here.
export const install: UserModule = () => {}
