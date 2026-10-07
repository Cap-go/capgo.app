import type { UserModule } from '~/types'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { registerNativeNotifications, setupNativeNotifications } from '~/services/nativeNotifications'
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

  useSupabase().auth.onAuthStateChange((_event, session) => {
    // Never bind an admin's device to the customer they are logged in as.
    userId = session?.user?.id && !isSpoofed() ? session.user.id : null
    // Defer: calling Supabase from inside this callback can deadlock the auth lock.
    setTimeout(() => void registerWhenActive(), 0)
  })
}
