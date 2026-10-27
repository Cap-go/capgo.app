import type { UserModule } from '~/types'
import { PiniaColada } from '@pinia/colada'
import { createPinia } from 'pinia'

// Setup Pinia
// https://pinia.esm.dev/
export const install: UserModule = ({ app }) => {
  const pinia = createPinia()
  app.use(pinia)
  // Query cache: pages show their last result at once when revisited and refresh it in the
  // background, instead of a spinner and a full reload on every navigation.
  // https://pinia-colada.esm.dev/
  app.use(PiniaColada, {
    queryOptions: {
      staleTime: 30_000,
      // The console polls nothing on focus today; keep refreshes tied to navigation.
      refetchOnWindowFocus: false,
    },
  })
}
