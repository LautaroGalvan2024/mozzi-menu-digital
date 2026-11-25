const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const publishableKeyPattern = /^sb_publishable_[A-Za-z0-9_-]{20,}$/

function requireSetting(name: string, pattern?: RegExp) {
  const value = process.env[name]?.trim()
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`Missing or invalid rehearsal setting ${name}`)
  }
  return value
}

function loopbackOrigin(name: string, defaultPort: number) {
  const raw = process.env[name]?.trim() || `http://127.0.0.1:${defaultPort}`
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(raw)) {
    throw new Error(`${name} must name an explicit HTTP port on 127.0.0.1`)
  }
  try {
    return new URL(raw)
  } catch {
    throw new Error(`${name} uses an invalid local port`)
  }
}

export function rehearsalEnvironment() {
  if (process.env.MOZZI_REHEARSAL_E2E !== '1') {
    throw new Error('Set MOZZI_REHEARSAL_E2E=1 only while the SSH tunnel points to the isolated stack')
  }
  const api = loopbackOrigin('MOZZI_REHEARSAL_API_URL', 18000)
  const web = loopbackOrigin('MOZZI_REHEARSAL_WEB_URL', 5173)
  if (api.origin === web.origin) throw new Error('The two rehearsal origins must be distinct')
  return {
    api,
    web,
    publishableKey: requireSetting('MOZZI_REHEARSAL_PUBLISHABLE_KEY', publishableKeyPattern),
    restoredMenuSlug: requireSetting('MOZZI_REHEARSAL_RESTORED_MENU_SLUG', slugPattern),
    restoredStoreSlug: requireSetting('MOZZI_REHEARSAL_RESTORED_STORE_SLUG', slugPattern),
    operator: {
      email: requireSetting('MOZZI_REHEARSAL_OPERATOR_EMAIL', /^mozzi-rehearsal-operator-[a-z0-9-]+@example\.test$/),
      password: requireSetting('MOZZI_REHEARSAL_OPERATOR_PASSWORD'),
    },
    superadmin: {
      email: requireSetting('MOZZI_REHEARSAL_SUPERADMIN_EMAIL', /^mozzi-rehearsal-superadmin-[a-z0-9-]+@example\.test$/),
      password: requireSetting('MOZZI_REHEARSAL_SUPERADMIN_PASSWORD'),
    },
  }
}

export const rehearsalFixtures = {
  slug: 'mozzi-rehearsal-orders',
  restaurantId: '60ab321c-f225-48a7-bfc6-23862c1d21a0',
  otherRestaurantId: '962eabb2-712f-402b-a563-d643afb5c81f',
  productName: 'Producto técnico de ensayo',
  restaurantName: 'Mozzi Ensayo Técnico',
  customerName: 'Comprador de ensayo técnico',
  storePhone: '+12025550100',
  customerPhone: '+12025550101',
} as const
