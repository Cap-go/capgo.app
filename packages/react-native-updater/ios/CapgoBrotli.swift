import Foundation
import Compression

enum CapgoBrotli {
  private static let maxOutputSize = 128 * 1024 * 1024

  static func decompress(input: URL, output: URL) throws {
    let data = try Data(contentsOf: input)
    let decoded = try decodeBrotli(data)
    try decoded.write(to: output)
  }

  private static func decodeBrotli(_ data: Data) throws -> Data {
    if #available(iOS 15.0, *) {
      var stream = compression_stream()
      var status = compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI)
      guard status != COMPRESSION_STATUS_ERROR else {
        throw NSError(domain: "capgo.brotli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brotli init failed"])
      }
      defer { compression_stream_destroy(&stream) }

      let chunkSize = 64 * 1024
      var output = Data()
      var finished = false

      try data.withUnsafeBytes { srcBuffer in
        guard let srcBase = srcBuffer.bindMemory(to: UInt8.self).baseAddress else {
          throw NSError(domain: "capgo.brotli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brotli decompress failed"])
        }
        stream.src_ptr = srcBase
        stream.src_size = data.count

        while !finished {
          var chunk = Data(count: chunkSize)
          let produced: Int = chunk.withUnsafeMutableBytes { dstBuffer in
            guard let dstBase = dstBuffer.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            stream.dst_ptr = dstBase
            stream.dst_size = chunkSize
            status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
            if status == COMPRESSION_STATUS_ERROR { return 0 }
            return chunkSize - stream.dst_size
          }
          if produced > 0 {
            output.append(chunk.prefix(produced))
            if output.count > maxOutputSize {
              throw NSError(domain: "capgo.brotli", code: 2, userInfo: [NSLocalizedDescriptionKey: "Brotli output too large"])
            }
          }
          if status == COMPRESSION_STATUS_END {
            finished = true
          } else if status != COMPRESSION_STATUS_OK {
            throw NSError(domain: "capgo.brotli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brotli decompress failed"])
          }
        }
      }

      if output.isEmpty {
        throw NSError(domain: "capgo.brotli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brotli decompress failed"])
      }
      return output
    }
    throw NSError(domain: "capgo.brotli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brotli decompress failed"])
  }
}
