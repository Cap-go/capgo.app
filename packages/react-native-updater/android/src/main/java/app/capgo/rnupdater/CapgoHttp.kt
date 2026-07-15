package app.capgo.rnupdater

import android.content.Context
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object CapgoHttp {
  private val client: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS)
    .build()

  fun client(): OkHttpClient = client

  fun createInfoObject(
    context: Context,
    versionName: String,
    channel: String? = null,
  ): JSONObject {
    return JSONObject()
      .put("platform", "android")
      .put("device_id", CapgoConfig.deviceId(context))
      .put("app_id", CapgoConfig.appId(context))
      .put("custom_id", "")
      .put("version_build", CapgoConfig.versionName(context))
      .put("version_code", CapgoConfig.versionCode(context))
      .put("version_os", Build.VERSION.RELEASE ?: "")
      .put("version_name", versionName)
      .put("plugin_version", CapgoConfig.PLUGIN_VERSION)
      .put("is_emulator", CapgoConfig.isEmulator())
      .put("is_prod", !CapgoConfig.isEmulator())
      .put("install_source", "react-native")
      .put("defaultChannel", channel ?: CapgoConfig.defaultChannel(context))
  }

  fun postJson(url: String, body: JSONObject): JSONObject {
    val request = Request.Builder()
      .url(url)
      .post(body.toString().toRequestBody("application/json".toMediaType()))
      .header("User-Agent", "CapgoRNUpdater/${CapgoConfig.PLUGIN_VERSION}")
      .build()
    client.newCall(request).execute().use { response ->
      val text = response.body?.string() ?: "{}"
      return try {
        JSONObject(text)
      } catch (_: Exception) {
        JSONObject().put("error", "invalid_json").put("message", text.take(200))
      }
    }
  }

  fun sendStats(context: Context, action: String, versionName: String, oldVersion: String = "") {
    val statsUrl = CapgoConfig.statsUrl(context)
    if (statsUrl.isEmpty()) return
    try {
      val body = createInfoObject(context, versionName)
        .put("action", action)
        .put("old_version_name", oldVersion)
      postJson(statsUrl, body)
    } catch (_: Exception) {
      // best-effort
    }
  }
}
