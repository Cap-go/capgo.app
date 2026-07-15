package app.capgo.rnupdater

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class BundleRecord(
  val id: String,
  val version: String,
  val status: String,
  val checksum: String,
  val downloaded: String,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "id" to id,
    "version" to version,
    "status" to status,
    "checksum" to checksum,
    "downloaded" to downloaded,
  )

  fun toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("version", version)
    .put("status", status)
    .put("checksum", checksum)
    .put("downloaded", downloaded)
}

object BundleStore {
  private const val INDEX = "bundles.json"

  fun root(context: Context): File {
    val dir = File(context.filesDir, "capgo_bundles")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  fun bundleDir(context: Context, id: String): File {
    val dir = File(root(context), id)
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  fun builtin(): BundleRecord = BundleRecord(
    id = CapgoConfig.KEY_BUILTIN,
    version = "builtin",
    status = "success",
    checksum = "",
    downloaded = "",
  )

  fun list(context: Context): List<BundleRecord> {
    val file = File(root(context), INDEX)
    if (!file.exists()) return emptyList()
    return try {
      val arr = JSONArray(file.readText())
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        BundleRecord(
          id = o.getString("id"),
          version = o.optString("version", ""),
          status = o.optString("status", "success"),
          checksum = o.optString("checksum", ""),
          downloaded = o.optString("downloaded", ""),
        )
      }
    } catch (_: Exception) {
      emptyList()
    }
  }

  fun save(context: Context, bundles: List<BundleRecord>) {
    val arr = JSONArray()
    bundles.forEach { arr.put(it.toJson()) }
    File(root(context), INDEX).writeText(arr.toString())
  }

  fun upsert(context: Context, record: BundleRecord) {
    val all = list(context).filter { it.id != record.id }.toMutableList()
    all.add(record)
    save(context, all)
  }

  fun get(context: Context, id: String): BundleRecord? {
    if (id == CapgoConfig.KEY_BUILTIN) return builtin()
    return list(context).firstOrNull { it.id == id }
  }

  fun currentId(context: Context): String {
    val prefs = context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
    return prefs.getString(CapgoConfig.KEY_CURRENT, CapgoConfig.KEY_BUILTIN) ?: CapgoConfig.KEY_BUILTIN
  }

  fun setCurrent(context: Context, id: String) {
    context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
      .edit().putString(CapgoConfig.KEY_CURRENT, id).apply()
  }

  fun nextId(context: Context): String? {
    return context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
      .getString(CapgoConfig.KEY_NEXT, null)
  }

  fun setNext(context: Context, id: String?) {
    context.getSharedPreferences(CapgoConfig.PREFS, Context.MODE_PRIVATE)
      .edit().putString(CapgoConfig.KEY_NEXT, id).apply()
  }

  fun newId(): String = UUID.randomUUID().toString()

  fun jsBundleFile(context: Context, id: String): File {
    return File(bundleDir(context, id), CapgoConfig.BUNDLE_FILE)
  }
}
