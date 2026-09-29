import { describe, expect, it } from 'vitest'
import { loginErrorMessage } from './LoginPage'

describe('loginErrorMessage', () => {
  it('distinguishes a disabled email provider from invalid credentials', () => {
    expect(loginErrorMessage('email_provider_disabled')).toBe(
      'El acceso por correo está deshabilitado en Supabase. Contactá al administrador.',
    )
    expect(loginErrorMessage('invalid_credentials')).toBe('Correo o contraseña incorrectos.')
  })
})
