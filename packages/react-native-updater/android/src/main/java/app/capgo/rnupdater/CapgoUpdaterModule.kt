package app.capgo.rnupdater

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class CapgoUpdaterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val executor = Executors.newCachedThreadPool()

  override fun getName(): String = "CapgoUpdater"

  private fun emit(event: String, params: WritableMap?) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, params)
  }

  private fun bundleToMap(record: BundleRecord): WritableMap {
    val map = Arguments.createMap()
    map.putString("id", record.id)
    map.putString("version", record.version)
    map.putString("status", record.status)
    map.putString("checksum", record.checksum)
    map.putString("downloaded", record.downloaded)
    return map
  }

  private fun currentVersionName(): String {
    val id = BundleStore.currentId(reactContext)
    val record = BundleStore.get(reactContext, id)
    return if (record == null || record.id == CapgoConfig.KEY_BUILTIN) {
      CapgoConfig.versionName(reactContext)
    } else {
      record.version
    }
  }

  @ReactMethod
  fun notifyAppReady(promise: Promise) {
    executor.execute {
      try {
        CapgoUpdater.notifyAppReady(reactContext)
        val current = BundleStore.get(reactContext, BundleStore.currentId(reactContext)) ?: BundleStore.builtin()
        emit("appReady", bundleToMap(current))
        promise.resolve(bundleToMap(current))
      } catch (e: Exception) {
        promise.reject("notify_fail", e)
      }
    }
  }

  @ReactMethod
  fun getLatest(options: ReadableMap, promise: Promise) {
    executor.execute {
      try {
        val channel = if (options.hasKey("channel")) options.getString("channel") else null
        val body = CapgoHttp.createInfoObject(reactContext, currentVersionName(), channel)
        val response = CapgoHttp.postJson(CapgoConfig.updateUrl(reactContext), body)
        val map = Arguments.createMap()
        if (response.has("error")) {
          map.putString("error", response.optString("error"))
          map.putString("message", response.optString("message"))
          map.putString("kind", response.optString("kind"))
          map.putString("version", currentVersionName())
          emit("noNeedUpdate", map)
          promise.resolve(map)
          return@execute
        }
        map.putString("version", response.optString("version"))
        map.putString("url", response.optString("url"))
        map.putString("sessionKey", response.optString("session_key"))
        if (response.has("checksum") && !response.isNull("checksum")) {
          map.putString("checksum", response.optString("checksum"))
        }
        if (response.has("manifest")) {
          val manifest = response.getJSONArray("manifest")
          val arr = Arguments.createArray()
          for (i in 0 until manifest.length()) {
            val entry = manifest.getJSONObject(i)
            val m = Arguments.createMap()
            m.putString("file_name", entry.optString("file_name", null))
            m.putString("file_hash", entry.optString("file_hash", null))
            m.putString("download_url", entry.optString("download_url", null))
            arr.pushMap(m)
          }
          map.putArray("manifest", arr)
        }
        CapgoHttp.sendStats(reactContext, "get", response.optString("version"))
        emit("updateAvailable", map)
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("get_latest_fail", e)
      }
    }
  }


  private fun readManifest(options: ReadableMap): JSONArray? {
    if (!options.hasKey("manifest") || options.isNull("manifest")) return null
    val readable = options.getArray("manifest") ?: return JSONArray()
    val manifest = JSONArray()
    for (i in 0 until readable.size()) {
      val entry = readable.getMap(i) ?: continue
      val o = JSONObject()
      o.put("file_name", entry.getString("file_name"))
      o.put("file_hash", if (entry.hasKey("file_hash")) entry.getString("file_hash") else "")
      o.put("download_url", entry.getString("download_url"))
      manifest.put(o)
    }
    return manifest
  }

  @ReactMethod
  fun download(options: ReadableMap, promise: Promise) {
    executor.execute {
      try {
        val url = options.getString("url") ?: ""
        val version = options.getString("version") ?: throw IllegalArgumentException("version required")
        val sessionKey = if (options.hasKey("sessionKey")) options.getString("sessionKey") else null
        val checksum = if (options.hasKey("checksum")) options.getString("checksum") else null
        val manifest = readManifest(options)

        val id = BundleStore.newId()
        val pending = BundleRecord(id, version, "downloading", checksum ?: "", "")
        BundleStore.upsert(reactContext, pending)

        val record = CapgoDownloader.download(
          reactContext,
          CapgoDownloader.DownloadRequest(
            id = id,
            version = version,
            url = url,
            sessionKey = sessionKey,
            checksum = checksum,
            manifest = manifest,
          ),
        ) { percent ->
          val event = Arguments.createMap()
          event.putInt("percent", percent)
          event.putMap("bundle", bundleToMap(pending.copy(status = "downloading")))
          emit("download", event)
        }

        val complete = Arguments.createMap()
        complete.putMap("bundle", bundleToMap(record))
        emit("downloadComplete", complete)
        promise.resolve(bundleToMap(record))
      } catch (e: Exception) {
        val fail = Arguments.createMap()
        fail.putString("error", e.message)
        emit("downloadFailed", fail)
        promise.reject("download_fail", e)
      }
    }
  }

  @ReactMethod
  fun set(options: ReadableMap, promise: Promise) {
    executor.execute {
      try {
        val id = options.getString("id") ?: throw IllegalArgumentException("id required")
        val record = BundleStore.get(reactContext, id) ?: throw IllegalStateException("bundle not found")
        check(id == CapgoConfig.KEY_BUILTIN || BundleStore.jsBundleFile(reactContext, id).exists()) {
          "bundle files missing"
        }
        BundleStore.setCurrent(reactContext, id)
        BundleStore.setNext(reactContext, null)
        CapgoHttp.sendStats(reactContext, "set", record.version)
        CapgoUpdater.reload(reactContext)
        promise.resolve(bundleToMap(record))
      } catch (e: Exception) {
        CapgoHttp.sendStats(reactContext, "set_fail", options.getString("id") ?: "")
        promise.reject("set_fail", e)
      }
    }
  }

  @ReactMethod
  fun next(options: ReadableMap, promise: Promise) {
    executor.execute {
      try {
        val id = options.getString("id") ?: throw IllegalArgumentException("id required")
        val record = BundleStore.get(reactContext, id) ?: throw IllegalStateException("bundle not found")
        BundleStore.setNext(reactContext, id)
        CapgoHttp.sendStats(reactContext, "set_next", record.version)
        promise.resolve(bundleToMap(record))
      } catch (e: Exception) {
        promise.reject("next_fail", e)
      }
    }
  }

  @ReactMethod
  fun reset(options: ReadableMap, promise: Promise) {
    executor.execute {
      try {
        CapgoUpdater.rollbackToBuiltin(reactContext)
        CapgoUpdater.reload(reactContext)
        promise.resolve(bundleToMap(BundleStore.builtin()))
      } catch (e: Exception) {
        promise.reject("reset_fail", e)
      }
    }
  }

  @ReactMethod
  fun current(promise: Promise) {
    val record = BundleStore.get(reactContext, BundleStore.currentId(reactContext)) ?: BundleStore.builtin()
    promise.resolve(bundleToMap(record))
  }

  @ReactMethod
  fun list(promise: Promise) {
    val arr = Arguments.createArray()
    arr.pushMap(bundleToMap(BundleStore.builtin()))
    BundleStore.list(reactContext).forEach { arr.pushMap(bundleToMap(it)) }
    val map = Arguments.createMap()
    map.putArray("bundles", arr)
    promise.resolve(map)
  }

  @ReactMethod
  fun getDeviceId(promise: Promise) {
    val map = Arguments.createMap()
    map.putString("deviceId", CapgoConfig.deviceId(reactContext))
    promise.resolve(map)
  }

  @ReactMethod
  fun getPluginVersion(promise: Promise) {
    val map = Arguments.createMap()
    map.putString("version", CapgoConfig.PLUGIN_VERSION)
    promise.resolve(map)
  }

  @ReactMethod
  fun setChannel(options: ReadableMap, promise: Promise) {
    val channel = options.getString("channel") ?: ""
    reactContext.getSharedPreferences(CapgoConfig.PREFS, android.content.Context.MODE_PRIVATE)
      .edit().putString(CapgoConfig.KEY_CHANNEL, channel).apply()
    val map = Arguments.createMap()
    map.putString("channel", channel)
    map.putString("status", "ok")
    promise.resolve(map)
  }

  @ReactMethod
  fun getChannel(promise: Promise) {
    val map = Arguments.createMap()
    map.putString("channel", CapgoConfig.defaultChannel(reactContext))
    map.putString("status", "ok")
    promise.resolve(map)
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // RN event emitter subscription is handled on JS side
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // no-op
  }
}
