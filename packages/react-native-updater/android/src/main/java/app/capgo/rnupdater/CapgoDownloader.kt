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
 */
object CapgoDownloader {
  fun interface Progress {
    fun onPercent(percent: Int)
  }

  fun download(
    context: Context,
    id: String,
    version: String,
    url: String,
    sessionKey: String?,
    checksum: String?,
    manifest: JSONArray?,
    progress: Progress?,
  ): BundleRecord {
    val dest = BundleStore.bundleDir(context, id)
    dest.listFiles()?.forEach { it.deleteRecursively() }
    dest.mkdirs()

    if (manifest != null && manifest.length() > 0) {
      CapgoHttp.sendStats(context, "download_manifest_start", version)
      downloadManifest(context, dest, version, manifest, progress)
      CapgoHttp.sendStats(context, "download_manifest_complete", version)
    } else if (url.isNotEmpty() && !url.contains("404.capgo.app")) {
      CapgoHttp.sendStats(context, "download_zip_start", version)
      downloadZip(dest, url, progress)
      CapgoHttp.sendStats(context, "download_zip_complete", version)
    } else {
      throw IllegalStateException("No manifest or zip url provided")
    }

    // Ensure primary RN bundle file exists
    val bundleFile = File(dest, CapgoConfig.BUNDLE_FILE)
    if (!bundleFile.exists()) {
      // Accept common alternate names from Metro exports
      val alt = listOf("index.bundle", "main.jsbundle", "index.jsbundle")
        .map { File(dest, it) }
        .firstOrNull { it.exists() }
      if (alt != null) {
        alt.copyTo(bundleFile, overwrite = true)
      } else {
        throw IllegalStateException("Downloaded bundle missing ${CapgoConfig.BUNDLE_FILE}")
      }
    }

    CapgoHttp.sendStats(context, "download_complete", version)
    progress?.onPercent(100)

    val record = BundleRecord(
      id = id,
      version = version,
      status = "success",
      checksum = checksum ?: "",
      downloaded = java.time.Instant.now().toString(),
    )
    BundleStore.upsert(context, record)
    return record
  }

  private fun downloadManifest(
    context: Context,
    dest: File,
    version: String,
    manifest: JSONArray,
    progress: Progress?,
  ) {
    val total = manifest.length()
    var done = 0
    for (i in 0 until total) {
      val entry = manifest.getJSONObject(i)
      val fileName = entry.optString("file_name", "")
      val fileHash = entry.optString("file_hash", "")
      val downloadUrl = entry.optString("download_url", "")
      if (fileName.isEmpty() || downloadUrl.isEmpty()) {
        CapgoHttp.sendStats(context, "download_manifest_file_fail", "$version:$fileName")
        throw IllegalStateException("Invalid manifest entry at $i")
      }

      val isBrotli = fileName.endsWith(".br")
      val targetName = if (isBrotli) fileName.removeSuffix(".br") else fileName
      val target = File(dest, targetName)
      target.parentFile?.mkdirs()

      // Reuse from other local bundles when hash matches
      val reused = findCachedByHash(context, fileHash, dest)
      if (reused != null) {
        reused.copyTo(target, overwrite = true)
      } else {
        val tmp = File(dest, "$targetName.download")
        httpDownloadToFile(downloadUrl, tmp)
        if (isBrotli) {
          try {
            decompressBrotli(tmp, target)
            tmp.delete()
          } catch (e: Exception) {
            CapgoHttp.sendStats(context, "download_manifest_brotli_fail", "$version:$fileName")
            throw e
          }
        } else {
          tmp.renameTo(target)
        }
      }

      if (fileHash.isNotEmpty()) {
        val actual = sha256(target)
        if (!actual.equals(fileHash, ignoreCase = true) && !fileHash.contains(":")) {
          // Encrypted checksums contain ':' or are RSA blobs; skip strict match then
          if (fileHash.length == 64) {
            CapgoHttp.sendStats(context, "download_manifest_checksum_fail", "$version:$fileName")
            throw IllegalStateException("Checksum mismatch for $fileName")
          }
        }
      }

      done++
      progress?.onPercent(((done.toDouble() / total) * 90).toInt().coerceIn(10, 90))
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
      if (!response.isSuccessful) {
        throw IllegalStateException("Download failed ${response.code} for $url")
      }
      val body = response.body ?: throw IllegalStateException("Empty body")
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
    ZipInputStream(BufferedInputStream(FileInputStream(zipFile))).use { zis ->
      var entry = zis.nextEntry
      while (entry != null) {
        val outFile = File(dest, entry.name)
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
