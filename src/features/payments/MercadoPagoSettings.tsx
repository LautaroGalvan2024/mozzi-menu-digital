import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

const connectionSchema = z.object({
  configured: z.boolean(),
  configurationIssue: z.enum(['invalid_client_id', 'missing_configuration']).nullable().optional(),
  environment: z.enum(['test', 'production']).optional(),
  connectionEnvironment: z.enum(['test', 'production']).nullable().optional(),
  readyForPayments: z.boolean().optional(),
  connectionIssue: z.enum(['not_connected', 'inactive', 'different_environment', 'reconnect_required']).nullable().optional(),
  connection: z.object({ connected: z.boolean().optional(), active: z.boolean().optional(), providerUserId: z.string().nullable().optional() }).passthrough().nullable(),
})

export function MercadoPagoSettings({ restaurantId }: { restaurantId: string }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connection = useQuery({
    queryKey: ['mercadopago-connection', restaurantId],
    queryFn: async () => {
      const response = await supabase.functions.invoke('mercadopago-connect', { body: { restaurantId, action: 'status' } })
      if (response.error) throw new Error('No pudimos consultar la conexión de Mercado Pago.')
      const parsed = connectionSchema.safeParse(response.data)
      if (!parsed.success) throw new Error('No pudimos verificar el estado de Mercado Pago. Volvé a consultar en unos instantes.')
      return parsed.data
    },
  })
  const connected = connection.data?.connection?.connected ?? connection.data?.connection?.active ?? false
  const canConnect = !connection.isError && connection.data?.configured === true && connection.data.configurationIssue == null
  const environment = connection.data?.environment
  const accountEnvironment = connection.data?.connectionEnvironment
  const issue = connection.data?.connectionIssue
  const ready = canConnect && connected && connection.data?.readyForPayments === true && Boolean(environment) && accountEnvironment === environment && issue == null
  const hasAccount = issue !== 'not_connected' && Boolean(connection.data?.connection && (
    connected || connection.data.connection.providerUserId || connection.data.connection.active != null || issue
  ))
  const reconnect = hasAccount || connected
  const environmentLabel = environment === 'production' ? 'Cobros reales' : environment === 'test' ? 'Modo prueba' : 'Ambiente sin verificar'
  const connectLabel = environment === 'production'
    ? reconnect ? 'Reconectar cuenta para cobros reales' : 'Conectar mi cuenta para cobros reales'
    : environment === 'test'
      ? reconnect ? 'Reconectar Mercado Pago para pruebas' : 'Conectar Mercado Pago para pruebas'
      : reconnect ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'
  const statusLabel = connection.isPending ? 'Consultando conexión…'
    : connection.isError ? 'Conexión sin verificar'
    : ready ? environment === 'production' ? 'Cuenta lista para cobros reales' : 'Cuenta lista para pruebas'
    : issue === 'inactive' ? 'Cobros desactivados'
    : issue === 'different_environment' || issue === 'reconnect_required' ? 'Necesita reconexión'
    : connected ? 'Cuenta conectada' : 'Sin conexión'

  async function act(action: 'connect' | 'disconnect') {
    if (busy || (action === 'connect' && !canConnect)) return
    setBusy(true); setError(null)
    try {
      const result = await supabase.functions.invoke('mercadopago-connect', { body: { restaurantId, action } })
      if (result.error) throw new Error(action === 'connect' ? 'No se pudo iniciar la conexión. Revisá tu sesión y la configuración del servicio.' : 'No se pudo desactivar la conexión.')
      if (action === 'connect') {
        const data = z.object({ authorizationUrl: z.string().url() }).parse(result.data)
        const url = new URL(data.authorizationUrl)
        if (url.origin !== 'https://auth.mercadopago.com' || url.pathname !== '/authorization') throw new Error('La dirección de autorización no es válida.')
        window.location.assign(url.href)
      } else {
        await Promise.all([cache.invalidateQueries({ queryKey: ['mercadopago-connection', restaurantId] }), cache.invalidateQueries({ queryKey: ['restaurant', restaurantId] })])
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo actualizar Mercado Pago.') }
    finally { setBusy(false) }
  }

  return <section className="form-card mb-6" aria-labelledby="mp-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="mp-title" className="form-card-title">Mercado Pago para tu tienda</h2>
      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${environment === 'test' ? 'bg-amber-50 text-amber-900' : 'bg-stone-100 text-stone-700'}`}>{environmentLabel}</span>
    </div>
    <p className="mt-2 text-sm leading-6 text-stone-600">Recibí los pagos en la cuenta de tu comercio. Autorizá a Mozzi desde Mercado Pago; no necesitás copiar claves.</p>
    <div className="mt-5 border-l-2 border-stone-200 pl-4">
      <p className={`text-sm font-semibold ${ready && environment === 'production' ? 'text-emerald-800' : ready ? 'text-sky-900' : 'text-stone-800'}`} role="status">{statusLabel}</p>
      {hasAccount ? <p className="mt-1 text-xs leading-6 text-stone-600">Autorización actual: {accountEnvironment === 'production' ? 'cobros reales' : accountEnvironment === 'test' ? 'prueba' : 'ambiente sin verificar'}.</p> : null}
      {environment ? <p className="mt-1 text-xs leading-6 text-stone-600">{environment === 'test' ? 'Este entorno está en modo prueba. Las compras de prueba no generan cobros reales.' : 'Este entorno utiliza cobros reales. El dinero se acredita en la cuenta autorizada del comercio.'}</p> : null}
      {connection.data && !environment ? <p className="mt-1 text-xs leading-6 text-stone-600">La conexión no informa su ambiente. Actualizá el estado antes de habilitar cobros.</p> : null}
    </div>
    {canConnect && (issue === 'different_environment' || issue === 'reconnect_required' || issue === 'inactive') ? <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900" role="alert">
      {issue === 'different_environment'
        ? environment === 'production'
          ? 'La autorización actual es para otro ambiente. Para cobrar dinero real, volvé a autorizar la cuenta de tu comercio. La conexión de prueba no se convierte automáticamente en una conexión para cobros reales.'
          : 'La autorización actual es para otro ambiente. Reconectá la cuenta para poder realizar compras de prueba.'
        : issue === 'inactive'
          ? 'Los nuevos cobros están desactivados. Reconectá tu cuenta para volver a habilitarlos.'
          : 'Esta autorización necesita renovarse antes de iniciar nuevos pagos. Reconectá la cuenta de tu comercio.'}
    </p> : null}
    {connection.data && (!connection.data.configured || connection.data.configurationIssue != null) ? <p className="mt-3 text-sm text-amber-800" role="alert">{connection.data.configurationIssue === 'invalid_client_id'
      ? 'El ID de la aplicación de Mercado Pago debe ser numérico. El administrador de Mozzi debe corregirlo para conectar la cuenta. Podés seguir recibiendo pedidos por WhatsApp.'
      : 'La conexión de pagos todavía no está configurada en la plataforma. Podés seguir recibiendo pedidos por WhatsApp.'}</p> : null}
    {connection.isError ? <p className="form-error mt-3" role="alert">{connection.error.message}</p> : null}
    {error ? <p className="form-error mt-3" role="alert">{error}</p> : null}
    <div className="mt-4 flex flex-wrap gap-3">
      {ready ? <a className="button-primary" href="/admin/tienda">Configurar pagos en la tienda</a> : <button type="button" className="button-primary" aria-busy={busy} disabled={busy || connection.isPending || !canConnect} onClick={() => void act('connect')}>{busy ? 'Procesando…' : connectLabel}</button>}
      <button type="button" className="button-quiet" disabled={busy || connection.isFetching} onClick={() => void connection.refetch()}>Actualizar estado</button>
    </div>
    {ready ? <p className="mt-3 text-xs leading-5 text-stone-600">Para ofrecer pagos online, activá también el stock y la opción de cobro en tu tienda.</p> : null}
    <details className="admin-disclosure mt-5">
      <summary>Cómo habilitar los cobros online</summary>
    <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-6 text-stone-600" aria-label="Pasos para habilitar pagos online">
      <li>Autorizá la cuenta de tu comercio para {environment === 'production' ? 'cobros reales' : environment === 'test' ? 'pruebas' : 'el ambiente configurado'}.</li>
      <li>Cargá las cantidades al crear o editar tus productos y variantes. Activá el control desde Stock si aún está sin activar.</li>
      <li>En Tienda online, marcá <strong>Publicar mi tienda online</strong>, habilitá <strong>Pagos online con Mercado Pago</strong> y guardá los cambios.</li>
    </ol>
    </details>
    {hasAccount ? <details className="admin-disclosure mt-3">
      <summary>Administrar conexión</summary>
      {connection.data?.connection?.providerUserId ? <p className="mt-4 text-sm text-stone-600">Cuenta de Mercado Pago: <span className="font-mono">{connection.data.connection.providerUserId}</span></p> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        {ready ? <button type="button" className="button-secondary" aria-busy={busy} disabled={busy || !canConnect} onClick={() => void act('connect')}>{busy ? 'Procesando…' : connectLabel}</button> : null}
        {connected ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void act('disconnect')}>Desactivar nuevos cobros</button> : null}
      </div>
      <p className="mt-3 text-xs leading-5 text-stone-500">Desactivar nuevos cobros conserva la conciliación de compras anteriores. Los reintegros se realizan desde Mercado Pago.</p>
    </details> : null}
  </section>
}
