import type { UserModule } from '~/types'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { registerNativeNotifications, setupNativeNotifications, unregisterNativeNotifications } from '~/services/nativeNotifications'
import { isSpoofed, useSupabase } from '~/services/supabase'

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

  useSupabase().auth.onAuthStateChange((event, session) => {
    // Never bind an admin's device to the customer they are logged in as.
    const previousUserId = userId
    userId = session?.user?.id && !isSpoofed() ? session.user.id : null
    // Defer: calling Supabase from inside this callback can deadlock the auth lock.
    setTimeout(() => {
      if (event === 'SIGNED_OUT' || (previousUserId && previousUserId !== userId))
        void unregisterNativeNotifications(event === 'SIGNED_OUT').then(() => registerWhenActive())
      else
        void registerWhenActive()
    }, 0)
  })
}
