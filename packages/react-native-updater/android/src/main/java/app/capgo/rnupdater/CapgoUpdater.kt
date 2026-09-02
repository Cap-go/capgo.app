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
    rollbackIfNotReady(context)
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
    if (!BundleStore.isBundleReady(context, record.id)) return
    val current = BundleStore.currentId(context)
    if (current != CapgoConfig.KEY_BUILTIN) {
      BundleStore.setPrevious(context, current)
    }
    BundleStore.setCurrent(context, record.id)
    BundleStore.setNext(context, null)
    context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(CapgoConfig.KEY_READY, false).apply()
  }

  @JvmStatic
  fun rollbackIfNotReady(context: Context) {
    val prefs = context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
    if (prefs.getBoolean(CapgoConfig.KEY_READY, true)) return
    val failed = BundleStore.get(context, BundleStore.currentId(context))
    val previous = BundleStore.previousId(context)
    if (previous != null && BundleStore.isBundleReady(context, previous)) {
      BundleStore.setCurrent(context, previous)
      BundleStore.setNext(context, null)
      prefs.edit().putBoolean(CapgoConfig.KEY_READY, true).apply()
      val target = BundleStore.get(context, previous)
      CapgoHttp.sendStats(context, "rollback", target?.version ?: "", failed?.version ?: "")
      return
    }
    if (BundleStore.currentId(context) == CapgoConfig.KEY_BUILTIN) {
      prefs.edit().putBoolean(CapgoConfig.KEY_READY, true).apply()
      return
    }
    rollbackToBuiltin(context, failed?.version ?: "", "rollback")
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
    rollbackToBuiltin(context, old?.version ?: "", "reset")
  }

  private fun rollbackToBuiltin(context: Context, oldVersion: String, action: String) {
    BundleStore.setCurrent(context, CapgoConfig.KEY_BUILTIN)
    BundleStore.setNext(context, null)
    BundleStore.setPrevious(context, null)
    context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(CapgoConfig.KEY_READY, true).apply()
    CapgoHttp.sendStats(context, action, "builtin", oldVersion)
  }

  @JvmStatic
  fun reload(context: Context) {
    Handler(Looper.getMainLooper()).post {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (intent == null) {
        Runtime.getRuntime().exit(0)
        return@post
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
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
