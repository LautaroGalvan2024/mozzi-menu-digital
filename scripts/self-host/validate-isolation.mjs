import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectName = 'mozzi-supabase'
const serviceNames = [
  'studio', 'api-gw', 'auth', 'rest', 'realtime', 'storage',
  'imgproxy', 'meta', 'functions', 'db', 'supavisor',
]
const templatesServiceName = 'auth-templates'

class IsolationError extends Error {}

function requireIsolation(condition, message) {
  if (!condition) throw new IsolationError(message)
}

function realPathAllowMissing(file) {
  try {
    return realpathSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT' || lstatSync(file, { throwIfNoEntry: false })) throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(realPathAllowMissing(parent), path.basename(file))
  }
}

function isWithin(directory, file) {
  const relative = path.relative(directory, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function pointsToInternalDatabase(value) {
  try {
    const url = new URL(value)
    return ['postgres:', 'postgresql:', 'ecto:'].includes(url.protocol)
      && url.hostname === 'db' && url.port === '5432' && url.search === ''
  } catch {
    return false
  }
}

export function validateIsolation(config, projectDirectory) {
  const volumeDirectory = path.join(realpathSync(projectDirectory), 'volumes')
  requireIsolation(config?.name === projectName, 'Se requiere el proyecto mozzi-supabase.')
  const services = config.services ?? {}
  const expectedServices = services[templatesServiceName] ? [...serviceNames, templatesServiceName] : serviceNames
  requireIsolation(Object.keys(services).length === expectedServices.length && expectedServices.every((name) => services[name]),
    'Los servicios difieren de la composición de Supabase revisada.')

  const network = config.networks?.default
  requireIsolation(Object.keys(config.networks ?? {}).length === 1 && network?.name === projectName + '_default'
    && !network.external && !network.driver_opts && (!network.driver || network.driver === 'bridge'),
  'Se requiere una red bridge dedicada al proyecto.')

  const volumes = config.volumes ?? {}
  for (const [name, volume] of Object.entries(volumes)) {
    requireIsolation(volume.name === projectName + '_' + name && !volume.external
      && !volume.driver_opts && (!volume.driver || volume.driver === 'local'),
    'Los volúmenes con nombre deben pertenecer al proyecto.')
  }

  for (const name of expectedServices) {
    const service = services[name]
    const ports = service.ports ?? []
    const [port] = ports
    requireIsolation(name === 'api-gw'
      ? ports.length === 1 && port.host_ip === '127.0.0.1'
        && Number(port.published) === 18000 && port.target === 8000 && port.protocol === 'tcp'
      : ports.length === 0, 'El único puerto publicado debe ser el gateway en 127.0.0.1:18000.')

    requireIsolation(name === 'realtime'
      ? service.container_name === 'realtime-dev.mozzi-supabase-realtime'
        && service.networks?.default?.aliases?.includes('realtime-dev.supabase-realtime')
      : !service.container_name, 'Los contenedores deben usar nombres propios del proyecto y preservar el alias de Realtime.')

    requireIsolation(Object.keys(service.networks ?? {}).join() === 'default' && !service.network_mode
      && !service.privileged && service.pid !== 'host' && service.ipc !== 'host'
      && !service.volumes_from?.length && !service.external_links?.length && !service.extra_hosts
      && !service.devices?.length && !service.configs?.length && !service.secrets?.length,
    'Un servicio intenta usar recursos fuera de la red o los volúmenes dedicados.')

    for (const mount of service.volumes ?? []) {
      requireIsolation(mount.type === 'volume' && Object.hasOwn(volumes, mount.source)
        || mount.type === 'bind' && path.isAbsolute(mount.source)
          && isWithin(volumeDirectory, mount.source) && isWithin(volumeDirectory, realPathAllowMissing(mount.source)),
      'Un volumen está fuera del directorio dedicado o apunta a un volumen externo.')
    }
  }

  const templates = services[templatesServiceName]
  if (templates) {
    const [mount] = templates.volumes ?? []
    requireIsolation(templates.read_only && templates.volumes?.length === 1 && mount.type === 'bind'
      && mount.read_only && mount.target === '/templates'
      && realPathAllowMissing(mount.source) === path.join(volumeDirectory, templatesServiceName),
    'Las plantillas de correo deben usar su directorio dedicado con acceso de solo lectura.')
    requireIsolation(services.auth.environment?.GOTRUE_MAILER_TEMPLATES_INVITE === 'http://auth-templates:8080/invite-es.html'
      && services.auth.environment?.GOTRUE_MAILER_TEMPLATES_RECOVERY === 'http://auth-templates:8080/recovery-es.html',
    'Auth debe leer las plantillas de correo dentro de la red de Supabase.')
  }

  const database = services.db
  const dataMount = database.volumes?.find((entry) => entry.target === '/var/lib/postgresql/data')
  const dataDirectory = path.join(volumeDirectory, 'db', 'data')
  requireIsolation(dataMount?.type === 'bind' && realPathAllowMissing(dataMount.source) === dataDirectory
    && database.environment?.POSTGRES_HOST === '/var/run/postgresql' && database.environment?.PGPORT === '5432',
  'PostgreSQL debe usar su directorio de datos dedicado y el socket interno.')

  requireIsolation(services.studio.environment?.POSTGRES_HOST === 'db'
    && services.realtime.environment?.DB_HOST === 'db' && services.realtime.environment?.DB_PORT === '5432'
    && services.meta.environment?.PG_META_DB_HOST === 'db' && services.meta.environment?.PG_META_DB_PORT === '5432'
    && services.supavisor.environment?.POSTGRES_HOST === 'db'
    && [
      services.auth.environment?.GOTRUE_DB_DATABASE_URL,
      services.rest.environment?.PGRST_DB_URI,
      services.storage.environment?.DATABASE_URL,
      services.functions.environment?.SUPABASE_DB_URL,
      services.supavisor.environment?.DATABASE_URL,
    ].every(pointsToInternalDatabase), 'Los servicios de Supabase deben usar la base interna db:5432.')
}

function main(projectDirectory, option) {
  requireIsolation(projectDirectory, 'Indicá el directorio de instalación de Supabase.')
  requireIsolation(!option || option === '--auth-templates', 'Opción de validación desconocida.')
  const directory = path.resolve(projectDirectory)
  const overlay = fileURLToPath(new URL('./compose.isolation.yml', import.meta.url))
  const templatesOverlay = fileURLToPath(new URL('./compose.auth-templates.yml', import.meta.url))
  const result = spawnSync('docker', [
    'compose', '--project-name', projectName, '--project-directory', directory,
    '--env-file', path.join(directory, '.env'), '-f', path.join(directory, 'docker-compose.yml'),
    '-f', overlay, ...(option ? ['-f', templatesOverlay] : []), 'config', '--format', 'json',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })

  requireIsolation(result.status === 0, 'Compose no pudo resolver la configuración. Revisá la versión y los archivos de instalación.')
  validateIsolation(JSON.parse(result.stdout), directory)
  console.log('Configuración validada. Gateway en 127.0.0.1:18000 y base de datos aislada.')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv[2], process.argv[3])
  } catch (error) {
    // Docker Compose and URL errors can contain credentials from the resolved configuration.
    console.error(error instanceof IsolationError ? error.message : 'No se pudo verificar el aislamiento de Supabase.')
    process.exitCode = 1
  }
}
