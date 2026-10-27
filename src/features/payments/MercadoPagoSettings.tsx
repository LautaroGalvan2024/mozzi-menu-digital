import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

const connectionSchema = z.object({
  configured: z.boolean(),
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
      return connectionSchema.parse(response.data)
    },
  })
  const connected = connection.data?.connection?.connected ?? connection.data?.connection?.active ?? false

  async function act(action: 'connect' | 'disconnect') {
    if (busy) return
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
      <span className={`rounded-full px-3 py-1 text-sm font-semibold ${connected ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-600'}`}>{connected ? 'Cuenta conectada' : 'Sin conexión'}</span>
    </div>
    <p className="mt-2 text-sm text-stone-600">Recibí las ventas directamente en tu cuenta. Para habilitar el pago online, activá el inventario y la opción de cobro en la configuración de la tienda.</p>
    {connected && connection.data?.connection?.providerUserId ? <p className="mt-2 text-sm">Cuenta: {connection.data.connection.providerUserId}</p> : null}
    {connection.data && !connection.data.configured ? <p className="mt-3 text-sm text-amber-800">La conexión de pagos todavía no está configurada en la plataforma. Podés seguir recibiendo pedidos por WhatsApp.</p> : null}
    {connection.isError ? <p className="form-error mt-3" role="alert">{connection.error.message}</p> : null}
    {error ? <p className="form-error mt-3" role="alert">{error}</p> : null}
    <div className="mt-4 flex flex-wrap gap-3">
      <button type="button" className="button-primary" disabled={busy || connection.isPending || !connection.data?.configured} onClick={() => void act('connect')}>{busy ? 'Procesando…' : connected ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'}</button>
      {connected ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void act('disconnect')}>Desactivar nuevos cobros</button> : null}
    </div>
    {connected ? <p className="mt-3 text-xs text-stone-500">Desactivar nuevos cobros conserva la conciliación de compras anteriores. Los reintegros se realizan desde Mercado Pago.</p> : null}
  </section>
}
