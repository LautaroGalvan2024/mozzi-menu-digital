import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const stackDirectory = '/srv/mozzi-supabase'
const gateway = 'http://127.0.0.1:18000'
const maximumConcurrentUploads = 4

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function getObjectPath(asset) {
  const segments = asset.name?.split('/') ?? []
  if (!/^[a-z0-9][a-z0-9-]+$/.test(asset.bucket) || !segments.length ||
    segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('Ruta de objeto inválida en el respaldo.')
  }
  return [asset.bucket, ...segments].map(encodeURIComponent).join('/')
}

async function readAsset(backupDirectory, asset) {
  if (!/^[a-f0-9-]{36}$/.test(asset.id) || asset.file !== `storage/${asset.id}.bin` ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('Identidad o checksum de objeto inválido en el respaldo.')
  }
  const filename = path.join(backupDirectory, asset.file)
  if (filename !== await realpath(filename)) throw new Error('Se encontró un enlace en el respaldo.')
  const bytes = await readFile(filename)
  if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) {
    throw new Error('Un archivo difiere de su checksum o tamaño.')
  }
  return bytes
}

async function getObject(objectPath, headers) {
  const response = await fetch(`${gateway}/storage/v1/object/authenticated/${objectPath}`, {
    headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (response.ok) return Buffer.from(await response.arrayBuffer())
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  if (response.status === 400) {
    const error = await response.json().catch(() => ({}))
    if (String(error?.statusCode) === '404' || error?.code === 'NoSuchKey') return null
  }
  await response.body?.cancel().catch(() => {})
  throw new Error(`Storage rechazó la lectura (HTTP ${response.status}).`)
}

async function restoreAsset(backupDirectory, asset, headers) {
  const objectPath = getObjectPath(asset)
  const bytes = await readAsset(backupDirectory, asset)
  let stored = await getObject(objectPath, headers)
  if (!stored) {
    const response = await fetch(`${gateway}/storage/v1/object/${objectPath}`, {
      method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {
        ...headers,
        'content-type': asset.metadata?.mimetype ?? 'application/octet-stream',
        'cache-control': asset.metadata?.cacheControl ?? 'max-age=3600',
        'x-upsert': 'false',
      },
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Storage rechazó la escritura (HTTP ${response.status}).`)
    stored = await getObject(objectPath, headers)
  }
  if (!stored || hash(stored) !== asset.sha256) {
    throw new Error('El objeto en destino difiere del respaldo. Se requiere revisión.')
  }
}

async function main() {
  if (process.cwd() !== stackDirectory || await realpath(stackDirectory) !== stackDirectory) {
    throw new Error('Ejecutá este script desde la ruta de Supabase aislada.')
  }
  const backupName = process.argv[2]
  if (!/^managed-source-[a-zA-Z0-9-]+$/.test(backupName ?? '')) {
    throw new Error('Indicá el nombre del respaldo completo en el directorio imports.')
  }
  const backupDirectory = path.join(stackDirectory, 'imports', backupName)
  if (backupDirectory !== await realpath(backupDirectory)) throw new Error('Ruta de respaldo inválida.')
  const manifest = JSON.parse(await readFile(path.join(backupDirectory, 'manifest.json'), 'utf8'))
  if (manifest.formatVersion !== 2 || !manifest.complete || !Array.isArray(manifest.assets) ||
    manifest.assets.length !== manifest.counts?.storage_objects) {
    throw new Error('El manifiesto de Storage está incompleto.')
  }

  const paths = new Set()
  for (const asset of manifest.assets) {
    const objectPath = getObjectPath(asset)
    if (paths.has(objectPath)) throw new Error('El respaldo repite un destino de Storage.')
    paths.add(objectPath)
    await readAsset(backupDirectory, asset)
  }

  const dotenv = await readFile(path.join(stackDirectory, '.env'), 'utf8')
  const serviceRoleKey = /^SERVICE_ROLE_KEY=([\w.-]+)$/m.exec(dotenv)?.[1]
  if (!serviceRoleKey) throw new Error('Falta la credencial de Storage de la instancia aislada.')
  const headers = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` }
  for (let start = 0; start < manifest.assets.length; start += maximumConcurrentUploads) {
    const batch = manifest.assets.slice(start, start + maximumConcurrentUploads)
    const results = await Promise.allSettled(batch.map(asset => restoreAsset(backupDirectory, asset, headers)))
    if (results.some(result => result.status === 'rejected')) {
      throw new Error(`La copia se interrumpió tras ${start} objetos verificados. Podés reintentar con el mismo respaldo.`)
    }
  }
  console.log(`Storage: ${manifest.assets.length} objetos verificados por SHA-256.`)
}

try {
  await main()
} catch (error) {
  // File and HTTP exceptions can include paths; display only messages defined here.
  const messages = ['Ruta ', 'Identidad ', 'Se encontró ', 'Un archivo ', 'Ejecutá ', 'Indicá ',
    'El manifiesto ', 'El respaldo ', 'Falta ', 'La copia ']
  console.error(messages.some(prefix => error.message.startsWith(prefix)) ? error.message : 'Error inesperado durante la restauración de Storage.')
  process.exitCode = 1
}
