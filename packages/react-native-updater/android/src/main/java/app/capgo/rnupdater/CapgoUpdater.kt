package app.capgo.rnupdater

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import java.io.File

/**
 * Public entry points for Application / ReactNativeHost wiring.
 */
object CapgoUpdater {
  /**
   * Call from ReactNativeHost.getJSBundleFile().
   * Returns the active Capgo bundle path or null to use the packaged bundle.
   */
  @JvmStatic
  fun getJSBundleFile(context: Context): String? {
    applyPendingNext(context)
    val id = BundleStore.currentId(context)
    if (id == CapgoConfig.KEY_BUILTIN) return null
    val file = BundleStore.jsBundleFile(context, id)
    return if (file.exists()) file.absolutePath else null
  }

  @JvmStatic
  fun applyPendingNext(context: Context) {
    val next = BundleStore.nextId(context) ?: return
    val record = BundleStore.get(context, next) ?: return
    if (BundleStore.jsBundleFile(context, record.id).exists()) {
      BundleStore.setCurrent(context, record.id)
      BundleStore.setNext(context, null)
      // Mark not ready until notifyAppReady
      context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(CapgoConfig.KEY_READY, false).apply()
    }
  }

  @JvmStatic
  fun notifyAppReady(context: Context) {
    context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(CapgoConfig.KEY_READY, true).apply()
    val current = BundleStore.get(context, BundleStore.currentId(context))
    CapgoHttp.sendStats(context, "set", current?.version ?: "builtin")
  }

  @JvmStatic
  fun rollbackToBuiltin(context: Context) {
    val old = BundleStore.get(context, BundleStore.currentId(context))
    BundleStore.setCurrent(context, CapgoConfig.KEY_BUILTIN)
    BundleStore.setNext(context, null)
    CapgoHttp.sendStats(context, "reset", "builtin", old?.version ?: "")
  }

  @JvmStatic
  fun reload(context: Context) {
    Handler(Looper.getMainLooper()).post {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      intent?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      Runtime.getRuntime().exit(0)
    }
  }

  @JvmStatic
  fun currentBundlePath(context: Context): File? {
    val path = getJSBundleFile(context) ?: return null
    return File(path)
  }
}
