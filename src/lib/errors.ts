export function errorMessage(error: unknown, fallback = 'Ocurrió un error inesperado.') {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

export function sanitizedErrorMessage(error: unknown) {
  void error
  return 'No se pudo completar la operación. Volvé a intentar.'
}
