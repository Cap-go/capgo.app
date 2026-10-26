import type { UserModule } from '~/types'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { isSpoofed, useConsole } from '~/services/console'
import { registerNativeNotifications, setupNativeNotifications, unregisterNativeNotifications } from '~/services/nativeNotifications'

export const install: UserModule = () => {
  if (!Capacitor.isNativePlatform())
    return
  void setupNativeNotifications()

  let userId: string | null = null
  const registerWhenActive = async () => {
    // A silent push can launch the app in the background; wait for the user to
    // open it so the permission prompt is never requested off-screen.
    if (!userId || !(await App.getState().catch(() => ({ isActive: false }))).isActive)
      return
    await registerNativeNotifications(userId)
  }

  void App.addListener('appStateChange', ({ isActive }) => {
    if (isActive)
      void registerWhenActive()
  })

  useConsole().auth.onAuthStateChange((event, session) => {
    // Never bind an admin's device to the customer they are logged in as.
    // Defer: calling the auth client from inside its own callback must not re-enter it,
    // and the spoof marker is written only after setSession resolves.
    setTimeout(() => {
      const previousUserId = userId
      userId = session?.user?.id && !isSpoofed() ? session.user.id : null
      if (event === 'SIGNED_OUT' || (previousUserId && previousUserId !== userId))
        void unregisterNativeNotifications(event === 'SIGNED_OUT').then(() => registerWhenActive())
      else
        void registerWhenActive()
    }, 0)
  })
}
