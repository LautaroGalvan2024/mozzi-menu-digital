import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

const host = '127.0.0.1'
const port = 4174
const root = resolve(process.cwd(), '.tmp', 'performance-dist')
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}
const compressible = new Set(['.css', '.html', '.js', '.json', '.svg'])
const fileCache = new Map()

function cacheFile(file) {
  const content = readFileSync(file)
  const extension = extname(file)
  const cached = {
    content,
    gzip: compressible.has(extension) ? gzipSync(content, { level: 9 }) : null,
  }
  fileCache.set(file, cached)
  return cached
}

function warmCache(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) warmCache(path)
    else if (entry.isFile()) cacheFile(path)
  }
}

// Compression happens before Playwright starts measuring the page. Runtime
// requests only read immutable buffers, matching a CDN with precompressed assets.
warmCache(root)

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}:${port}`).pathname)
  const requested = resolve(root, `.${pathname}`)
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
    response.writeHead(400).end('Invalid path')
    return
  }
  const file = existsSync(requested) && statSync(requested).isFile()
    ? requested
    : resolve(root, 'index.html')
  const extension = extname(file)
  const headers = {
    'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    Vary: 'Accept-Encoding',
  }
  const cached = fileCache.get(file) ?? cacheFile(file)
  if (cached.gzip && request.headers['accept-encoding']?.includes('gzip')) {
    response.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' })
    response.end(cached.gzip)
    return
  }
  response.writeHead(200, headers)
  response.end(cached.content)
}).listen(port, host, () => {
  console.log(`Performance preview listening on http://${host}:${port}`)
})
