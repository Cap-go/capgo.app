import Foundation
import UIKit
import React
import CryptoKit

@objc(CapgoUpdater)
public class CapgoUpdater: RCTEventEmitter {
  private static let pluginVersion = "0.1.0"
  private static let prefsSuite = "capgo_rn_updater"
  private static let bundleFileName = "main.jsbundle"
  private static let androidBundleFileName = "index.android.bundle"

  private let queue = DispatchQueue(label: "app.capgo.rnupdater", qos: .userInitiated)

  public override static func requiresMainQueueSetup() -> Bool { true }
  public override func supportedEvents() -> [String]! {
    ["download", "downloadComplete", "downloadFailed", "updateAvailable", "noNeedUpdate", "updateFailed", "appReady"]
  }

  // MARK: - Public static API for AppDelegate

  @objc public static func getJSBundleURL() -> URL? {
    applyPendingNext()
    let defaults = UserDefaults.standard
    let id = defaults.string(forKey: "capgo_current_bundle_id") ?? "builtin"
    if id == "builtin" { return nil }
    let file = bundleDir(id: id).appendingPathComponent(bundleFileName)
    if FileManager.default.fileExists(atPath: file.path) {
      return file
    }
    let alt = bundleDir(id: id).appendingPathComponent(androidBundleFileName)
    if FileManager.default.fileExists(atPath: alt.path) {
      return alt
    }
    return nil
  }

  @objc public static func applyPendingNext() {
    let defaults = UserDefaults.standard
    guard let next = defaults.string(forKey: "capgo_next_bundle_id") else { return }
    let file = bundleDir(id: next).appendingPathComponent(bundleFileName)
    let alt = bundleDir(id: next).appendingPathComponent(androidBundleFileName)
    if FileManager.default.fileExists(atPath: file.path) || FileManager.default.fileExists(atPath: alt.path) {
      defaults.set(next, forKey: "capgo_current_bundle_id")
      defaults.removeObject(forKey: "capgo_next_bundle_id")
      defaults.set(false, forKey: "capgo_app_ready")
    }
  }

  private static func rootDir() -> URL {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let root = docs.appendingPathComponent("capgo_bundles", isDirectory: true)
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private static func bundleDir(id: String) -> URL {
    let dir = rootDir().appendingPathComponent(id, isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func appId() -> String {
    Bundle.main.object(forInfoDictionaryKey: "CapgoAppId") as? String
      ?? Bundle.main.bundleIdentifier
      ?? "unknown"
  }

  private func updateUrl() -> String {
    Bundle.main.object(forInfoDictionaryKey: "CapgoUpdateUrl") as? String
      ?? "https://plugin.capgo.app/updates"
  }

  private func statsUrl() -> String {
    Bundle.main.object(forInfoDictionaryKey: "CapgoStatsUrl") as? String
      ?? "https://plugin.capgo.app/stats"
  }

  private func deviceId() -> String {
    let key = "capgo_device_id"
    if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
      return String(existing.prefix(36))
    }
    let id = UUID().uuidString
    UserDefaults.standard.set(id, forKey: key)
    return id
  }

  private func versionBuild() -> String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
  }

  private func currentVersionName() -> String {
    let id = UserDefaults.standard.string(forKey: "capgo_current_bundle_id") ?? "builtin"
    if id == "builtin" { return versionBuild() }
    if let bundles = loadIndex(),
       let match = bundles.first(where: { ($0["id"] as? String) == id }),
       let version = match["version"] as? String {
      return version
    }
    return versionBuild()
  }

  private func indexFile() -> URL {
    CapgoUpdater.rootDir().appendingPathComponent("bundles.json")
  }

  private func loadIndex() -> [[String: Any]]? {
    guard let data = try? Data(contentsOf: indexFile()),
          let json = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return nil
    }
    return json
  }

  private func saveIndex(_ bundles: [[String: Any]]) {
    if let data = try? JSONSerialization.data(withJSONObject: bundles) {
      try? data.write(to: indexFile())
    }
  }

  private func upsert(_ record: [String: Any]) {
    var all = loadIndex() ?? []
    let id = record["id"] as? String
    all = all.filter { ($0["id"] as? String) != id }
    all.append(record)
    saveIndex(all)
  }

  private func createInfoObject(versionName: String, channel: String?) -> [String: Any] {
    [
      "platform": "ios",
      "device_id": deviceId(),
      "app_id": appId(),
      "custom_id": "",
      "version_build": versionBuild(),
      "version_code": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
      "version_os": UIDevice.current.systemVersion,
      "version_name": versionName,
      "plugin_version": CapgoUpdater.pluginVersion,
      "is_emulator": isSimulator(),
      "is_prod": !isSimulator(),
      "install_source": "react-native",
      "defaultChannel": channel
        ?? UserDefaults.standard.string(forKey: "capgo_default_channel")
        ?? (Bundle.main.object(forInfoDictionaryKey: "CapgoDefaultChannel") as? String)
        ?? "",
    ]
  }

  private func isSimulator() -> Bool {
    #if targetEnvironment(simulator)
    return true
    #else
    return false
    #endif
  }

  private func postJson(url: String, body: [String: Any]) throws -> [String: Any] {
    guard let endpoint = URL(string: url) else { throw NSError(domain: "capgo", code: 1) }
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("CapgoRNUpdater/\(CapgoUpdater.pluginVersion)", forHTTPHeaderField: "User-Agent")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let sem = DispatchSemaphore(value: 0)
    var result: [String: Any] = [:]
    var err: Error?
    URLSession.shared.dataTask(with: request) { data, _, error in
      defer { sem.signal() }
      if let error = error { err = error; return }
      guard let data = data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        result = ["error": "invalid_json"]
        return
      }
      result = json
    }.resume()
    sem.wait()
    if let err = err { throw err }
    return result
  }

  private func sendStats(action: String, versionName: String, oldVersion: String = "") {
    var body = createInfoObject(versionName: versionName, channel: nil)
    body["action"] = action
    body["old_version_name"] = oldVersion
    _ = try? postJson(url: statsUrl(), body: body)
  }

  private func sha256(path: URL) -> String {
    guard let data = try? Data(contentsOf: path) else { return "" }
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  // MARK: - Bridge methods

  @objc func notifyAppReady(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    queue.async {
      UserDefaults.standard.set(true, forKey: "capgo_app_ready")
      let id = UserDefaults.standard.string(forKey: "capgo_current_bundle_id") ?? "builtin"
      let record = self.bundleMap(id: id)
      self.sendStats(action: "set", versionName: record["version"] as? String ?? "builtin")
      self.sendEvent(withName: "appReady", body: record)
      resolve(record)
    }
  }

  @objc func getLatest(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    queue.async {
      do {
        let channel = options["channel"] as? String
        let body = self.createInfoObject(versionName: self.currentVersionName(), channel: channel)
        let response = try self.postJson(url: self.updateUrl(), body: body)
        if response["error"] != nil {
          var map: [String: Any] = [
            "error": response["error"] as Any,
            "message": response["message"] as Any,
            "kind": response["kind"] as Any,
            "version": self.currentVersionName(),
          ]
          self.sendEvent(withName: "noNeedUpdate", body: map)
          resolve(map)
          return
        }
        var map: [String: Any] = [
          "version": response["version"] as Any,
          "url": response["url"] as Any,
          "sessionKey": response["session_key"] as Any,
        ]
        if let checksum = response["checksum"] {
          map["checksum"] = checksum
        }
        if let manifest = response["manifest"] as? [[String: Any]] {
          map["manifest"] = manifest
        }
        self.sendStats(action: "get", versionName: response["version"] as? String ?? "")
        self.sendEvent(withName: "updateAvailable", body: map)
        resolve(map)
      } catch {
        reject("get_latest_fail", error.localizedDescription, error)
      }
    }
  }

  @objc func download(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    queue.async {
      do {
        guard let version = options["version"] as? String else {
          throw NSError(domain: "capgo", code: 2, userInfo: [NSLocalizedDescriptionKey: "version required"])
        }
        let url = options["url"] as? String ?? ""
        let checksum = options["checksum"] as? String ?? ""
        let manifest = options["manifest"] as? [[String: Any]]
        let id = UUID().uuidString
        let dest = CapgoUpdater.bundleDir(id: id)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        if let manifest = manifest, !manifest.isEmpty {
          self.sendStats(action: "download_manifest_start", versionName: version)
          try self.downloadManifest(manifest, to: dest, version: version)
          self.sendStats(action: "download_manifest_complete", versionName: version)
        } else if !url.isEmpty && !url.contains("404.capgo.app") {
          self.sendStats(action: "download_zip_start", versionName: version)
          try self.downloadZip(url: url, to: dest)
          self.sendStats(action: "download_zip_complete", versionName: version)
        } else {
          throw NSError(domain: "capgo", code: 3, userInfo: [NSLocalizedDescriptionKey: "No manifest or zip url"])
        }

        let main = dest.appendingPathComponent(CapgoUpdater.bundleFileName)
        if !FileManager.default.fileExists(atPath: main.path) {
          let altNames = [CapgoUpdater.androidBundleFileName, "index.bundle", "index.jsbundle"]
          for name in altNames {
            let alt = dest.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: alt.path) {
              try FileManager.default.copyItem(at: alt, to: main)
              break
            }
          }
        }
        guard FileManager.default.fileExists(atPath: main.path) else {
          throw NSError(domain: "capgo", code: 4, userInfo: [NSLocalizedDescriptionKey: "Missing main.jsbundle"])
        }

        self.sendStats(action: "download_complete", versionName: version)
        let record: [String: Any] = [
          "id": id,
          "version": version,
          "status": "success",
          "checksum": checksum,
          "downloaded": ISO8601DateFormatter().string(from: Date()),
        ]
        self.upsert(record)
        self.sendEvent(withName: "downloadComplete", body: ["bundle": record])
        resolve(record)
      } catch {
        self.sendEvent(withName: "downloadFailed", body: ["error": error.localizedDescription])
        reject("download_fail", error.localizedDescription, error)
      }
    }
  }

  private func downloadManifest(_ manifest: [[String: Any]], to dest: URL, version: String) throws {
    let total = max(manifest.count, 1)
    for (index, entry) in manifest.enumerated() {
      guard let fileName = entry["file_name"] as? String,
            let downloadUrl = entry["download_url"] as? String,
            let remote = URL(string: downloadUrl) else {
        sendStats(action: "download_manifest_file_fail", versionName: "\(version)")
        throw NSError(domain: "capgo", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid manifest entry"])
      }
      let isBrotli = fileName.hasSuffix(".br")
      let targetName = isBrotli ? String(fileName.dropLast(3)) : fileName
      let target = dest.appendingPathComponent(targetName)
      try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)

      let tmp = dest.appendingPathComponent("\(targetName).download")
      let data = try Data(contentsOf: remote)
      try data.write(to: tmp)
      if isBrotli {
        do {
          try CapgoBrotli.decompress(input: tmp, output: target)
          try? FileManager.default.removeItem(at: tmp)
        } catch {
          sendStats(action: "download_manifest_brotli_fail", versionName: "\(version):\(fileName)")
          throw error
        }
      } else {
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: tmp, to: target)
      }

      if let fileHash = entry["file_hash"] as? String, fileHash.count == 64 {
        let actual = sha256(path: target)
        if actual.lowercased() != fileHash.lowercased() {
          sendStats(action: "download_manifest_checksum_fail", versionName: "\(version):\(fileName)")
          throw NSError(domain: "capgo", code: 6, userInfo: [NSLocalizedDescriptionKey: "Checksum mismatch"])
        }
      }

      let percent = Int((Double(index + 1) / Double(total)) * 90.0)
      sendEvent(withName: "download", body: ["percent": max(10, percent)])
    }
  }

  private func downloadZip(url: String, to dest: URL) throws {
    guard let remote = URL(string: url) else { throw NSError(domain: "capgo", code: 7) }
    let zipURL = dest.appendingPathComponent("bundle.zip")
    let data = try Data(contentsOf: remote)
    try data.write(to: zipURL)
    try CapgoZip.unzip(zipURL, to: dest)
    try? FileManager.default.removeItem(at: zipURL)
  }

  @objc func set(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    queue.async {
      guard let id = options["id"] as? String else {
        reject("set_fail", "id required", nil)
        return
      }
      let record = self.bundleMap(id: id)
      UserDefaults.standard.set(id, forKey: "capgo_current_bundle_id")
      UserDefaults.standard.removeObject(forKey: "capgo_next_bundle_id")
      self.sendStats(action: "set", versionName: record["version"] as? String ?? id)
      resolve(record)
      DispatchQueue.main.async {
        exit(0)
      }
    }
  }

  @objc func next(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let id = options["id"] as? String else {
      reject("next_fail", "id required", nil)
      return
    }
    UserDefaults.standard.set(id, forKey: "capgo_next_bundle_id")
    let record = bundleMap(id: id)
    sendStats(action: "set_next", versionName: record["version"] as? String ?? id)
    resolve(record)
  }

  @objc func reset(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let old = currentVersionName()
    UserDefaults.standard.set("builtin", forKey: "capgo_current_bundle_id")
    UserDefaults.standard.removeObject(forKey: "capgo_next_bundle_id")
    sendStats(action: "reset", versionName: "builtin", oldVersion: old)
    resolve(bundleMap(id: "builtin"))
    DispatchQueue.main.async { exit(0) }
  }

  @objc func current(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let id = UserDefaults.standard.string(forKey: "capgo_current_bundle_id") ?? "builtin"
    resolve(bundleMap(id: id))
  }

  @objc func list(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var bundles: [[String: Any]] = [bundleMap(id: "builtin")]
    if let stored = loadIndex() {
      bundles.append(contentsOf: stored)
    }
    resolve(["bundles": bundles])
  }

  @objc func getDeviceId(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(["deviceId": deviceId()])
  }

  @objc func getPluginVersion(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(["version": CapgoUpdater.pluginVersion])
  }

  @objc func setChannel(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let channel = options["channel"] as? String ?? ""
    UserDefaults.standard.set(channel, forKey: "capgo_default_channel")
    resolve(["channel": channel, "status": "ok"])
  }

  @objc func getChannel(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let channel = UserDefaults.standard.string(forKey: "capgo_default_channel")
      ?? (Bundle.main.object(forInfoDictionaryKey: "CapgoDefaultChannel") as? String)
      ?? ""
    resolve(["channel": channel, "status": "ok"])
  }

  private func bundleMap(id: String) -> [String: Any] {
    if id == "builtin" {
      return [
        "id": "builtin",
        "version": "builtin",
        "status": "success",
        "checksum": "",
        "downloaded": "",
      ]
    }
    if let match = loadIndex()?.first(where: { ($0["id"] as? String) == id }) {
      return match
    }
    return ["id": id, "version": id, "status": "error", "checksum": "", "downloaded": ""]
  }
}
