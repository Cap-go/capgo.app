package app.capgo.rnupdater

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.util.UUID

object CapgoConfig {
  const val PLUGIN_VERSION = "0.1.0"
  const val DEFAULT_UPDATE_URL = "https://plugin.capgo.app/updates"
  const val DEFAULT_STATS_URL = "https://plugin.capgo.app/stats"
  const val DEFAULT_CHANNEL_URL = "https://plugin.capgo.app/channel_self"
  const val BUNDLE_FILE = "index.android.bundle"
  const val PREFS = "capgo_rn_updater"
  const val KEY_CURRENT = "current_bundle_id"
  const val KEY_NEXT = "next_bundle_id"
  const val KEY_DEVICE = "device_id"
  const val KEY_READY = "app_ready"
  const val KEY_CHANNEL = "default_channel"
  const val KEY_BUILTIN = "builtin"

  fun appId(context: Context): String {
    return meta(context, "CapgoAppId")
      ?: context.packageName
  }

  fun updateUrl(context: Context): String {
    return meta(context, "CapgoUpdateUrl") ?: DEFAULT_UPDATE_URL
  }

  fun statsUrl(context: Context): String {
    return meta(context, "CapgoStatsUrl") ?: DEFAULT_STATS_URL
  }

  fun channelUrl(context: Context): String {
    return meta(context, "CapgoChannelUrl") ?: DEFAULT_CHANNEL_URL
  }

  fun publicKey(context: Context): String? = meta(context, "CapgoPublicKey")

  fun defaultChannel(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return prefs.getString(KEY_CHANNEL, null)
      ?: meta(context, "CapgoDefaultChannel")
      ?: ""
  }

  fun versionName(context: Context): String {
    return try {
      val pi = context.packageManager.getPackageInfo(context.packageName, 0)
      pi.versionName ?: "0.0.0"
    } catch (_: Exception) {
      "0.0.0"
    }
  }

  fun versionCode(context: Context): String {
    return try {
      val pi = context.packageManager.getPackageInfo(context.packageName, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pi.longVersionCode.toString()
      } else {
        @Suppress("DEPRECATION")
        pi.versionCode.toString()
      }
    } catch (_: Exception) {
      "0"
    }
  }

  fun deviceId(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val existing = prefs.getString(KEY_DEVICE, null)
    if (!existing.isNullOrEmpty()) return existing
    val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    val id = (androidId ?: UUID.randomUUID().toString()).take(36)
    prefs.edit().putString(KEY_DEVICE, id).apply()
    return id
  }

  fun isEmulator(): Boolean {
    return (Build.FINGERPRINT.startsWith("generic")
      || Build.FINGERPRINT.lowercase().contains("emulator")
      || Build.MODEL.contains("Emulator")
      || Build.MODEL.contains("Android SDK built for x86")
      || Build.MANUFACTURER.contains("Genymotion")
      || Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic")
      || "google_sdk" == Build.PRODUCT)
  }

  private fun meta(context: Context, key: String): String? {
    return try {
      val ai = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      ai.metaData?.getString(key)
    } catch (_: Exception) {
      null
    }
  }
}
