# CapgoNotificationsPlugin triggers the updater through reflection when an
# update_check push arrives. Keep the entry point when the host app minifies.
-keepclassmembers class ee.forgr.capacitor_updater.CapacitorUpdaterPlugin {
    public java.lang.String triggerBackgroundUpdateCheck();
}
-keep class ee.forgr.capacitor_updater.HeadlessUpdateWorker {
    public static void enqueue(android.content.Context);
}
