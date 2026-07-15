import Foundation
import Compression

enum CapgoZip {
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
      var compSize = Int(readU32(data, offset + 18))
      var uncompSize = Int(readU32(data, offset + 22))
      let nameLen = Int(readU16(data, offset + 26))
      let extraLen = Int(readU16(data, offset + 28))
      let nameStart = offset + 30
      let nameData = data.subdata(in: nameStart..<(nameStart + nameLen))
      let name = String(data: nameData, encoding: .utf8) ?? "file"
      var dataStart = nameStart + nameLen + extraLen

      // Data descriptor (bit 3) — sizes after payload; rare for Capgo zips
      if flags & 0x8 != 0 && compSize == 0 {
        // Cannot reliably stream without end-of-central-directory; fail clearly
        throw NSError(domain: "capgo.zip", code: 3, userInfo: [NSLocalizedDescriptionKey: "Zip data descriptors not supported"])
      }

      let payload = data.subdata(in: dataStart..<(dataStart + compSize))
      let outURL = destination.appendingPathComponent(name)
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
      _ = uncompSize
    }
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

    // ZIP uses raw deflate; Compression ZLIB expects zlib wrapper.
    // Prepend synthetic zlib header+adler is hard; use COMPRESSION_ZLIB with windowBits workaround:
    // Apple Compression does not expose raw deflate directly in older SDKs.
    // Prefer wrapping: 0x78 0x01 + data + adler32 — skip, use larger buffer with ZLIB which often works for zip-deflate via:
    let dstCapacity = max(expectedSize, data.count * 8, 64 * 1024)
    var output = Data(count: dstCapacity)
    let decodedCount: Int = data.withUnsafeBytes { srcBuffer in
      output.withUnsafeMutableBytes { dstBuffer in
        guard let src = srcBuffer.bindMemory(to: UInt8.self).baseAddress,
              let dst = dstBuffer.bindMemory(to: UInt8.self).baseAddress else { return 0 }
        stream.src_ptr = src
        stream.src_size = data.count
        stream.dst_ptr = dst
        stream.dst_size = dstCapacity
        status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
        if status == COMPRESSION_STATUS_END || status == COMPRESSION_STATUS_OK {
          return dstCapacity - stream.dst_size
        }
        return 0
      }
    }
    if decodedCount > 0 {
      output.count = decodedCount
      return output
    }
    // Fallback: try decode_buffer with COMPRESSION_ZLIB
    let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: dstCapacity)
    defer { dst.deallocate() }
    let n = data.withUnsafeBytes { src -> Int in
      guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
      return compression_decode_buffer(dst, dstCapacity, base, data.count, nil, COMPRESSION_ZLIB)
    }
    if n > 0 {
      return Data(bytes: dst, count: n)
    }
    throw NSError(domain: "capgo.zip", code: 2, userInfo: [NSLocalizedDescriptionKey: "Deflate failed"])
  }
}
