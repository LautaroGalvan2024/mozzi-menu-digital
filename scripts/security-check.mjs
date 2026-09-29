import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const findings = []

function gitFiles(argumentsList) {
  const result = spawnSync('git', argumentsList, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })

  if (result.status !== 0) {
    console.error('No se pudo consultar Git para ejecutar los controles de seguridad.')
    process.exit(2)
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter(Boolean)
}

function addFinding(file, rule) {
  findings.push({ file: file.replaceAll('\\', '/'), rule })
}

function isRealEnvironmentFile(file) {
  const basename = path.basename(file)
  return (basename === '.env' || basename.startsWith('.env.')) && !basename.endsWith('.example')
}

function decodeJwtRole(token) {
  try {
    const payload = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    return decoded?.role
  } catch {
    return undefined
  }
}

const trackedFiles = gitFiles(['ls-files'])
const candidateFiles = gitFiles(['ls-files', '-co', '--exclude-standard'])

for (const file of trackedFiles) {
  if (isRealEnvironmentFile(file)) {
    addFinding(file, 'archivo de entorno real versionado')
  }
}

for (const file of candidateFiles) {
  const normalized = file.replaceAll('\\', '/')

  if (
    normalized.startsWith('node_modules/') ||
    normalized.startsWith('dist/') ||
    normalized.startsWith('.git/') ||
    /\.(?:png|jpe?g|webp|gif|ico|woff2?|zip|xlsx|pdf)$/iu.test(normalized)
  ) {
    continue
  }

  let contents
  try {
    contents = await readFile(path.join(root, file), 'utf8')
  } catch {
    continue
  }

  if (contents.includes('\0')) {
    continue
  }

  if (/sb_secret_[A-Za-z0-9_-]{16,}/u.test(contents)) {
    addFinding(file, 'posible Supabase secret key literal')
  }

  const jwtCandidates = contents.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu) ?? []
  if (jwtCandidates.some((candidate) => decodeJwtRole(candidate) === 'service_role')) {
    addFinding(file, 'JWT administrativo literal')
  }

  if (
    (normalized.startsWith('src/') || path.basename(file).startsWith('.env') ||
      ['package.json', 'vite.config.ts', 'vercel.json'].includes(normalized)) &&
    /VITE_[A-Z0-9_]*(?:SERVICE|SECRET|PRIVATE|DATABASE|PASSWORD|TOKEN)[A-Z0-9_]*/u.test(contents)
  ) {
    addFinding(file, 'variable VITE_* con nombre sensible')
  }

  if (normalized.startsWith('src/')) {
    if (/\bSUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY)\b/iu.test(contents)) {
      addFinding(file, 'referencia a una clave administrativa de Supabase en el frontend')
    }
    if (/\bservice_role\b/iu.test(contents)) {
      addFinding(file, 'referencia a service_role en el frontend')
    }
    if (/dangerouslySetInnerHTML/u.test(contents)) {
      addFinding(file, 'uso de dangerouslySetInnerHTML')
    }
    if (/\.auth\.signUp\s*\(/u.test(contents)) {
      addFinding(file, 'flujo de registro público en el frontend')
    }
  }

  if (normalized.startsWith('supabase/functions/')) {
    if (/Access-Control-Allow-Origin["'\s:]*["']\*["']/iu.test(contents)) {
      addFinding(file, 'CORS wildcard en Edge Function')
    }
  }

  if (normalized.startsWith('supabase/migrations/')) {
    if (/disable\s+row\s+level\s+security/iu.test(contents)) {
      addFinding(file, 'migración deshabilita RLS')
    }
    if (/\busing\s*\(\s*true\s*\)/iu.test(contents)) {
      addFinding(file, 'política RLS con USING (true)')
    }
  }
}

const uniqueFindings = [...new Map(findings.map((finding) => [`${finding.file}:${finding.rule}`, finding])).values()]

if (uniqueFindings.length > 0) {
  console.error(`El control de seguridad encontró ${uniqueFindings.length} problema(s):`)
  for (const finding of uniqueFindings) {
    console.error(`- ${finding.file}: ${finding.rule}`)
  }
  console.error('No se imprimieron valores encontrados para evitar filtrar secretos.')
  process.exit(1)
}

console.log('Controles estáticos de seguridad completados sin hallazgos.')
