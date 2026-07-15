import Foundation
import Compression

enum CapgoBrotli {
  static func decompress(input: URL, output: URL) throws {
    let data = try Data(contentsOf: input)
    // Prefer Apple Compression framework brotli if available (iOS 15.4+ decode path via Compression)
    // Fallback: try NSData with brotli via compression_decode if encoded as raw brotli stream.
    let decoded = try decodeBrotli(data)
    try decoded.write(to: output)
  }

  private static func decodeBrotli(_ data: Data) throws -> Data {
    // Use compression_decode_buffer with COMPRESSION_BROTLI when available.
    if #available(iOS 15.0, *) {
      let dstCapacity = max(data.count * 6, 64 * 1024)
      let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: dstCapacity)
      defer { dst.deallocate() }
      let decodedSize = data.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Int in
        guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
        return compression_decode_buffer(
          dst, dstCapacity,
          base, data.count,
          nil,
          COMPRESSION_BROTLI
        )
      }
      if decodedSize > 0 {
        return Data(bytes: dst, count: decodedSize)
      }
    }
    throw NSError(domain: "capgo.brotli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brotli decompress failed"])
  }
}
