package app.capgo.rnupdater

import android.content.Context
import okhttp3.Request
import org.brotli.dec.BrotliInputStream
import org.json.JSONArray
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * Downloads Capgo bundles via full zip or file-level delta manifest
 * (same contract as @capgo/capacitor-updater).
 *
 * Encrypted Capgo bundles (non-empty sessionKey) are rejected in v0.1 —
 * ship unencrypted delta uploads, or wait for crypto parity with Capacitor.
 */
object CapgoDownloader {
  fun interface Progress {
    fun onPercent(percent: Int)
  }

  data class DownloadRequest(
    val id: String,
    val version: String,
    val url: String,
    val sessionKey: String?,
    val checksum: String?,
    val manifest: JSONArray?,
  )

  fun download(
    context: Context,
    request: DownloadRequest,
    progress: Progress?,
  ): BundleRecord {
    if (!request.sessionKey.isNullOrBlank()) {
      error("Encrypted Capgo updates are not supported yet in @capgo/react-native-updater. Upload without encryption or omit session_key.")
    }

    val dest = BundleStore.bundleDir(context, request.id)
    dest.listFiles()?.forEach { it.deleteRecursively() }
    dest.mkdirs()
    val canonicalDest = dest.canonicalFile

    val manifest = request.manifest
    when {
      manifest != null && manifest.length() > 0 -> {
        CapgoHttp.sendStats(context, "download_manifest_start", request.version)
        downloadManifest(context, canonicalDest, request.version, manifest, progress)
        CapgoHttp.sendStats(context, "download_manifest_complete", request.version)
      }
      request.url.isNotEmpty() && !request.url.contains("404.capgo.app") -> {
        CapgoHttp.sendStats(context, "download_zip_start", request.version)
        downloadZip(canonicalDest, request.url, progress)
        CapgoHttp.sendStats(context, "download_zip_complete", request.version)
      }
      else -> error("No manifest or zip url provided")
    }

    ensureBundleFile(canonicalDest)
    CapgoHttp.sendStats(context, "download_complete", request.version)
    progress?.onPercent(100)

    val record = BundleRecord(
      id = request.id,
      version = request.version,
      status = "success",
      checksum = request.checksum ?: "",
      downloaded = java.time.Instant.now().toString(),
    )
    BundleStore.upsert(context, record)
    return record
  }

  private fun safeTarget(dest: File, relativePath: String): File {
    val target = File(dest, relativePath).canonicalFile
    val prefix = dest.canonicalPath + File.separator
    require(target.path == dest.canonicalPath || target.path.startsWith(prefix)) {
      "Path escapes bundle directory: $relativePath"
    }
    return target
  }

  private fun ensureBundleFile(dest: File) {
    val bundleFile = File(dest, CapgoConfig.BUNDLE_FILE)
    if (bundleFile.exists()) return
    val alt = listOf("index.bundle", "main.jsbundle", "index.jsbundle")
      .map { File(dest, it) }
      .firstOrNull { it.exists() }
      ?: error("Downloaded bundle missing ${CapgoConfig.BUNDLE_FILE}")
    alt.copyTo(bundleFile, overwrite = true)
  }

  private fun downloadManifest(
    context: Context,
    dest: File,
    version: String,
    manifest: JSONArray,
    progress: Progress?,
  ) {
    val total = manifest.length()
    for (i in 0 until total) {
      downloadManifestEntry(context, dest, version, manifest.getJSONObject(i))
      progress?.onPercent((((i + 1).toDouble() / total) * 90).toInt().coerceIn(10, 90))
    }
  }

  private fun downloadManifestEntry(
    context: Context,
    dest: File,
    version: String,
    entry: org.json.JSONObject,
  ) {
    val fileName = entry.optString("file_name", "")
    val fileHash = entry.optString("file_hash", "")
    val downloadUrl = entry.optString("download_url", "")
    if (fileName.isEmpty() || downloadUrl.isEmpty()) {
      CapgoHttp.sendStats(context, "download_manifest_file_fail", "$version:$fileName")
      error("Invalid manifest entry")
    }

    val isBrotli = fileName.endsWith(".br")
    val targetName = if (isBrotli) fileName.removeSuffix(".br") else fileName
    val target = safeTarget(dest, targetName)
    target.parentFile?.mkdirs()

    val reused = findCachedByHash(context, fileHash, dest)
    if (reused != null) {
      reused.copyTo(target, overwrite = true)
    } else {
      writeDownloadedFile(context, version, fileName, downloadUrl, target, isBrotli)
    }

    verifyChecksum(context, version, fileName, fileHash, target)
  }

  private fun writeDownloadedFile(
    context: Context,
    version: String,
    fileName: String,
    downloadUrl: String,
    target: File,
    isBrotli: Boolean,
  ) {
    val tmp = File(target.parentFile, "${target.name}.download")
    httpDownloadToFile(downloadUrl, tmp)
    if (isBrotli) {
      try {
        decompressBrotli(tmp, target)
      } catch (e: Exception) {
        CapgoHttp.sendStats(context, "download_manifest_brotli_fail", "$version:$fileName")
        tmp.delete()
        throw e
      }
      tmp.delete()
      return
    }
    if (!tmp.renameTo(target)) {
      tmp.copyTo(target, overwrite = true)
      tmp.delete()
    }
  }

  private fun verifyChecksum(
    context: Context,
    version: String,
    fileName: String,
    fileHash: String,
    target: File,
  ) {
    if (fileHash.length != 64) return
    val actual = sha256(target)
    if (!actual.equals(fileHash, ignoreCase = true)) {
      CapgoHttp.sendStats(context, "download_manifest_checksum_fail", "$version:$fileName")
      error("Checksum mismatch for $fileName")
    }
  }

  private fun findCachedByHash(context: Context, hash: String, exclude: File): File? {
    if (hash.length != 64) return null
    val root = BundleStore.root(context)
    root.listFiles()?.forEach { bundle ->
      if (!bundle.isDirectory || bundle.absolutePath == exclude.absolutePath) return@forEach
      walkFiles(bundle).forEach { file ->
        if (sha256(file).equals(hash, ignoreCase = true)) return file
      }
    }
    return null
  }

  private fun walkFiles(dir: File): Sequence<File> = sequence {
    dir.listFiles()?.forEach { f ->
      if (f.isDirectory) yieldAll(walkFiles(f)) else yield(f)
    }
  }

  private fun downloadZip(dest: File, url: String, progress: Progress?) {
    val zipFile = File(dest, "bundle.zip")
    httpDownloadToFile(url, zipFile)
    progress?.onPercent(70)
    unzip(zipFile, dest)
    zipFile.delete()
  }

  private fun httpDownloadToFile(url: String, dest: File) {
    val request = Request.Builder().url(url).get().build()
    CapgoHttp.client().newCall(request).execute().use { response ->
      check(response.isSuccessful) { "Download failed ${response.code} for $url" }
      val body = response.body ?: error("Empty body")
      FileOutputStream(dest).use { out ->
        body.byteStream().use { input -> input.copyTo(out) }
      }
    }
  }

  private fun decompressBrotli(input: File, output: File) {
    BufferedInputStream(FileInputStream(input)).use { bis ->
      BrotliInputStream(bis).use { brotli ->
        FileOutputStream(output).use { out ->
          brotli.copyTo(out)
        }
      }
    }
  }

  private fun unzip(zipFile: File, dest: File) {
    val canonicalDest = dest.canonicalFile
    ZipInputStream(BufferedInputStream(FileInputStream(zipFile))).use { zis ->
      var entry = zis.nextEntry
      while (entry != null) {
        val outFile = safeTarget(canonicalDest, entry.name)
        if (entry.isDirectory) {
          outFile.mkdirs()
        } else {
          outFile.parentFile?.mkdirs()
          FileOutputStream(outFile).use { out -> zis.copyTo(out) }
        }
        zis.closeEntry()
        entry = zis.nextEntry
      }
    }
  }

  fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buf = ByteArray(8192)
      var read: Int
      while (input.read(buf).also { read = it } != -1) {
        digest.update(buf, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
