import Foundation
import Compression

enum CapgoZip {
  private static let maxInflateSize = 128 * 1024 * 1024

  static func unzip(_ zipURL: URL, to destination: URL) throws {
    try ZipArchive.extract(zipURL: zipURL, to: destination)
  }
}

/// Tiny zip reader supporting store (0) and deflate (8) entries.
enum ZipArchive {
  static func extract(zipURL: URL, to destination: URL) throws {
    let data = try Data(contentsOf: zipURL)
    var offset = 0
    while offset + 30 <= data.count {
      let sig = readU32(data, offset)
      if sig != 0x04034b50 { break }
      let method = Int(readU16(data, offset + 8))
      let flags = Int(readU16(data, offset + 6))
      let compSize = Int(readU32(data, offset + 18))
      let uncompSize = Int(readU32(data, offset + 22))
      let nameLen = Int(readU16(data, offset + 26))
      let extraLen = Int(readU16(data, offset + 28))
      let nameStart = offset + 30
      guard nameLen <= data.count - nameStart else {
        throw NSError(domain: "capgo.zip", code: 5, userInfo: [NSLocalizedDescriptionKey: "Truncated ZIP filename"])
      }
      let nameData = data.subdata(in: nameStart..<(nameStart + nameLen))
      let name = String(data: nameData, encoding: .utf8) ?? "file"
      let dataStart = nameStart + nameLen + extraLen
      guard dataStart >= nameStart,
            dataStart <= data.count,
            compSize <= data.count - dataStart else {
        throw NSError(domain: "capgo.zip", code: 5, userInfo: [NSLocalizedDescriptionKey: "Truncated ZIP entry"])
      }

      if flags & 0x8 != 0 && compSize == 0 {
        throw NSError(domain: "capgo.zip", code: 3, userInfo: [NSLocalizedDescriptionKey: "Zip data descriptors not supported"])
      }

      let payload = data.subdata(in: dataStart..<(dataStart + compSize))
      let outURL = try safeURL(destination: destination, name: name)
      if name.hasSuffix("/") {
        try FileManager.default.createDirectory(at: outURL, withIntermediateDirectories: true)
      } else {
        try FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let outData: Data
        if method == 0 {
          outData = payload
        } else if method == 8 {
          outData = try inflateRaw(payload, expectedSize: max(uncompSize, 1))
        } else {
          throw NSError(domain: "capgo.zip", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported zip method \(method)"])
        }
        try outData.write(to: outURL)
      }
      offset = dataStart + compSize
    }
  }

  private static func safeURL(destination: URL, name: String) throws -> URL {
    let dest = destination.standardizedFileURL
    let out = dest.appendingPathComponent(name).standardizedFileURL
    let destPath = dest.path.hasSuffix("/") ? dest.path : dest.path + "/"
    guard out.path == dest.path || out.path.hasPrefix(destPath) else {
      throw NSError(domain: "capgo.zip", code: 4, userInfo: [NSLocalizedDescriptionKey: "Path escapes bundle directory: \(name)"])
    }
    return out
  }

  private static func readU16(_ data: Data, _ o: Int) -> UInt16 {
    UInt16(data[o]) | (UInt16(data[o + 1]) << 8)
  }

  private static func readU32(_ data: Data, _ o: Int) -> UInt32 {
    UInt32(data[o])
      | (UInt32(data[o + 1]) << 8)
      | (UInt32(data[o + 2]) << 16)
      | (UInt32(data[o + 3]) << 24)
  }

  private static func inflateRaw(_ data: Data, expectedSize: Int) throws -> Data {
    var stream = compression_stream()
    var status = compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
    guard status != COMPRESSION_STATUS_ERROR else {
      throw NSError(domain: "capgo.zip", code: 2, userInfo: [NSLocalizedDescriptionKey: "Deflate init failed"])
    }
    defer { compression_stream_destroy(&stream) }

    let chunkSize = 64 * 1024
    var output = Data()
    var finished = false

    try data.withUnsafeBytes { srcBuffer in
      guard let src = srcBuffer.bindMemory(to: UInt8.self).baseAddress else {
        throw NSError(domain: "capgo.zip", code: 2, userInfo: [NSLocalizedDescriptionKey: "Deflate failed"])
      }
      stream.src_ptr = src
      stream.src_size = data.count

      while !finished {
        var chunk = Data(count: chunkSize)
        let produced: Int = chunk.withUnsafeMutableBytes { dstBuffer in
          guard let dst = dstBuffer.bindMemory(to: UInt8.self).baseAddress else { return 0 }
          stream.dst_ptr = dst
          stream.dst_size = chunkSize
          status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
          if status == COMPRESSION_STATUS_ERROR { return 0 }
          return chunkSize - stream.dst_size
        }
        if produced > 0 {
          output.append(chunk.prefix(produced))
          if output.count > maxInflateSize {
            throw NSError(domain: "capgo.zip", code: 2, userInfo: [NSLocalizedDescriptionKey: "Inflated entry too large"])
          }
        }
        if status == COMPRESSION_STATUS_END {
          finished = true
        } else if status != COMPRESSION_STATUS_OK {
          throw NSError(domain: "capgo.zip", code: 2, userInfo: [NSLocalizedDescriptionKey: "Deflate failed"])
        }
      }
    }

    if output.isEmpty {
      throw NSError(domain: "capgo.zip", code: 2, userInfo: [NSLocalizedDescriptionKey: "Deflate failed"])
    }
    return output
  }
}
