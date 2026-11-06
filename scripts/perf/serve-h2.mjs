// HTTP/2 + TLS static SPA server with brotli and immutable assets, like the Cloudflare deployment,
// so request counts and transfer sizes in scripts/perf/runtime-bench.ts match production.
//
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/perf-key.pem -out /tmp/perf-cert.pem -days 2 -subj "/CN=localhost"
//   node scripts/perf/serve-h2.mjs <dist dir> <port> /tmp/perf-key.pem /tmp/perf-cert.pem
import { existsSync, readFileSync, statSync } from 'node:fs'
import http2 from 'node:http2'
import path from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

const [dir, port, keyPath, certPath] = process.argv.slice(2)
const root = path.resolve(dir)
const cache = new Map()
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' }
const server = http2.createSecureServer({ key: readFileSync(keyPath), cert: readFileSync(certPath), allowHTTP1: true })
server.on('request', (req, res) => {
  const url = new URL(req.url, 'https://localhost')
  let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`)
  // Never serve anything outside the build directory (e.g. encoded ../ segments).
  if (!file.startsWith(`${root}${path.sep}`) || !existsSync(file) || statSync(file).isDirectory())
    file = path.join(root, 'index.html')
  const ext = path.extname(file)
  const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' }
  let body = readFileSync(file)
  if (/\.(?:html|js|css|json|svg|webmanifest)$/.test(file) && String(req.headers['accept-encoding'] ?? '').includes('br')) {
    let compressed = cache.get(file)
    if (!compressed) {
      compressed = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
      cache.set(file, compressed)
    }
    body = compressed
    headers['content-encoding'] = 'br'
  }
  res.writeHead(200, headers)
  res.end(body)
})
server.listen(Number(port), '127.0.0.1', () => console.log(`h2 ${dir} on ${port}`))
