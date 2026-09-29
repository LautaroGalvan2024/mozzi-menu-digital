import { createClient } from '@supabase/supabase-js'

const PROFILE_NAME = 'Lautaro Galván'
const PAGE_SIZE = 1_000

function fail(message: string): never {
  console.error(`Bootstrap cancelado: ${message}`)
  process.exit(1)
}

function argumentValue(name: string): string | undefined {
  const inlinePrefix = `--${name}=`
  const inline = process.argv.find((argument) => argument.startsWith(inlinePrefix))

  if (inline) {
    return inline.slice(inlinePrefix.length)
  }

  const position = process.argv.indexOf(`--${name}`)
  return position >= 0 ? process.argv[position + 1] : undefined
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    fail(`falta la variable ${name}`)
  }

  return value
}

function isAdministrativeKey(value: string): boolean {
  return /^sb_secret_[A-Za-z0-9_-]+$/.test(value) && value.length >= 24
}

if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.VERCEL) {
  fail('este script es exclusivamente local y no puede ejecutarse en CI o Vercel')
}

const supabaseUrl = requiredEnvironment('SUPABASE_URL')
const secretKey = requiredEnvironment('SUPABASE_SECRET_KEY')
const email = (argumentValue('email') ?? process.env.SUPER_ADMIN_EMAIL)?.trim().toLowerCase()

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail('indicá un correo válido con --email o SUPER_ADMIN_EMAIL')
}

if (!isAdministrativeKey(secretKey)) {
  fail('SUPABASE_SECRET_KEY no contiene una clave administrativa válida')
}

let parsedUrl: URL
try {
  parsedUrl = new URL(supabaseUrl)
} catch {
  fail('SUPABASE_URL no es una URL válida')
}

if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost') {
  fail('SUPABASE_URL debe usar HTTPS, excepto al trabajar con Supabase local')
}

const supabase = createClient(supabaseUrl, secretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const matches = []
let page = 1

while (true) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE_SIZE })

  if (error) {
    fail(`Supabase Auth rechazó la búsqueda (${error.code ?? 'auth_error'})`)
  }

  matches.push(
    ...data.users.filter((user) => user.email?.trim().toLowerCase() === email),
  )

  if (data.users.length < PAGE_SIZE) {
    break
  }

  page += 1
}

if (matches.length !== 1) {
  fail(`se esperaba exactamente un usuario confirmado y se encontraron ${matches.length}`)
}

const authUser = matches[0]

if (!authUser.email_confirmed_at) {
  fail('el usuario existe, pero su correo todavía no está confirmado')
}

const { error: profileError } = await supabase.from('profiles').upsert(
  {
    id: authUser.id,
    full_name: PROFILE_NAME,
    email: authUser.email,
    active: true,
  },
  { onConflict: 'id' },
)

if (profileError) {
  fail(`no se pudo actualizar el perfil (${profileError.code})`)
}

const { error: roleError } = await supabase.from('platform_user_roles').upsert(
  {
    user_id: authUser.id,
    role: 'super_admin',
    created_by: authUser.id,
  },
  { onConflict: 'user_id,role', ignoreDuplicates: true },
)

if (roleError) {
  fail(`no se pudo asignar el rol (${roleError.code})`)
}

const { error: auditError } = await supabase.from('audit_logs').insert({
  restaurant_id: null,
  actor_user_id: authUser.id,
  action: 'activate',
  entity_type: 'platform_user_role',
  entity_id: authUser.id,
  before_data: null,
  after_data: { role: 'super_admin', profile_active: true },
  metadata: { source: 'local_bootstrap' },
})

if (auditError) {
  fail(`el rol quedó asignado, pero no se pudo registrar la auditoría (${auditError.code}); corregí el problema y volvé a ejecutar el script`)
}

console.log('Bootstrap completado: perfil activo, rol super_admin y auditoría registrados.')
console.log('Siguiente paso: iniciar sesión, enrolar TOTP y verificar una operación protegida con AAL2.')
