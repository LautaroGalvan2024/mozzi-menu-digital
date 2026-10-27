import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Link } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'

interface SettingsForm {
  name: string; tradeName: string; description: string; whatsappPhone: string; address: string; city: string
  timezone: string; currencyCode: string; locale: string; primaryColor: string; secondaryColor: string
  deliveryEnabled: boolean; pickupEnabled: boolean; minimumOrder: string; preparationMinutes: string; publicMenuEnabled: boolean
}

export function RestaurantSettingsPage() {
  const { selected } = useRestaurantScope()
  return <RestaurantSettings key={selected?.id ?? 'none'} restaurantId={selected?.id} />
}

function RestaurantSettings({ restaurantId }: { restaurantId: string | undefined }) {
  const query = useRestaurant(restaurantId)
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!query.data || form) return
    const r = query.data
    setForm({ name: r.name, tradeName: r.trade_name, description: r.description, whatsappPhone: r.whatsapp_phone_e164, address: r.address, city: r.city, timezone: r.timezone, currencyCode: r.currency_code, locale: r.locale, primaryColor: r.primary_color, secondaryColor: r.secondary_color, deliveryEnabled: r.delivery_enabled, pickupEnabled: r.pickup_enabled, minimumOrder: (Number(r.minimum_order_cents) / 100).toString(), preparationMinutes: r.default_preparation_minutes.toString(), publicMenuEnabled: r.public_menu_enabled })
  }, [query.data, form])
  if (query.isLoading) return <LoadingScreen />
  if (query.error) return <ErrorPanel>{query.error.message}</ErrorPanel>
  if (!form) return <LoadingScreen />
  const currentForm = form
  function change<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) { setForm(current => current ? { ...current, [key]: value } : current); setMessage(null) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || !restaurantId) return
    setMessage(null); setError(null)
    const minimumOrderCents = Math.round(Number(currentForm.minimumOrder.replace(',', '.')) * 100)
    const preparation = Number(currentForm.preparationMinutes)
    if (!Number.isSafeInteger(minimumOrderCents) || minimumOrderCents < 0 || !Number.isInteger(preparation) || preparation < 5 || preparation > 240) { setError('Revisá el pedido mínimo y el tiempo de preparación.'); return }
    if (!currentForm.deliveryEnabled && !currentForm.pickupEnabled) { setError('Habilitá al menos envío o retiro.'); return }
    setSaving(true)
    try {
      // Store publication and checkout settings belong to /admin/tienda. Saving
      // identity or delivery must not overwrite changes made in that screen.
      const { data, error: updateError } = await supabase.from('restaurants').update({ name: currentForm.name.trim(), trade_name: currentForm.tradeName.trim(), description: currentForm.description.trim(), whatsapp_phone_e164: currentForm.whatsappPhone.trim(), address: currentForm.address.trim(), city: currentForm.city.trim(), timezone: currentForm.timezone.trim(), currency_code: currentForm.currencyCode.trim().toUpperCase(), locale: currentForm.locale.trim(), primary_color: currentForm.primaryColor, secondary_color: currentForm.secondaryColor, delivery_enabled: currentForm.deliveryEnabled, pickup_enabled: currentForm.pickupEnabled, minimum_order_cents: minimumOrderCents, default_preparation_minutes: preparation, public_menu_enabled: currentForm.publicMenuEnabled }).eq('id', restaurantId).select('id').maybeSingle()
      if (updateError) { setError('No se pudo guardar la configuración. Revisá los datos e intentá de nuevo.'); return }
      if (!data || data.id !== restaurantId) { setError('El comercio cambió o ya no está disponible. Actualizá la vista e intentá nuevamente.'); return }
      setMessage('Configuración guardada.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['restaurant', restaurantId] }),
        queryClient.invalidateQueries({ queryKey: ['restaurant-scope-choices'] }),
        queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
        queryClient.invalidateQueries({ queryKey: ['public-catalog'] }),
      ])
    } catch { setError('No se pudo guardar la configuración. Verificá tu conexión e intentá nuevamente.') }
    finally { setSaving(false) }
  }

  return <>
    <PageHeader eyebrow="Tu comercio" title="Configuración general" description="Datos de contacto y preferencias de atención." />
    <form className="space-y-5" onSubmit={submit} onInvalidCapture={event => { const section = (event.target as HTMLElement).closest('details'); if (section) section.open = true }}>
      <fieldset disabled={saving} className="space-y-5">
        <section className="form-card">
          <h2 className="form-card-title">Datos del comercio</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="field"><span>Nombre comercial</span><input value={form.tradeName} maxLength={120} onChange={event => change('tradeName', event.target.value)} required /></label>
            <label className="field"><span>WhatsApp</span><input type="tel" value={form.whatsappPhone} maxLength={20} onChange={event => change('whatsappPhone', event.target.value)} required /><span className="text-xs font-normal text-stone-500">Incluí código de país. Ejemplo: +5491123456789.</span></label>
            <label className="field"><span>Dirección</span><input value={form.address} maxLength={180} onChange={event => change('address', event.target.value)} required /></label>
            <label className="field"><span>Ciudad</span><input value={form.city} maxLength={100} onChange={event => change('city', event.target.value)} required /></label>
            <label className="field sm:col-span-2"><span>Descripción</span><textarea rows={2} maxLength={800} value={form.description} onChange={event => change('description', event.target.value)} placeholder="Contales a tus clientes qué ofrecés." /></label>
          </div>
        </section>
        <section className="form-card">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="form-card-title">Atención y entrega</h2><Link className="text-sm font-medium text-orange-700 hover:underline" to="/admin/horarios">Editar horarios</Link></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="field"><span>Pedido mínimo</span><input type="number" min="0" step="0.01" value={form.minimumOrder} onChange={event => change('minimumOrder', event.target.value)} /></label>
            <label className="field"><span>Preparación (minutos)</span><input type="number" min="5" max="240" value={form.preparationMinutes} onChange={event => change('preparationMinutes', event.target.value)} /></label>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-5"><label className="check-field"><input type="checkbox" checked={form.pickupEnabled} onChange={event => change('pickupEnabled', event.target.checked)} />Retiro habilitado</label><label className="check-field"><input type="checkbox" checked={form.deliveryEnabled} onChange={event => change('deliveryEnabled', event.target.checked)} />Envío habilitado</label>{form.deliveryEnabled ? <Link className="text-sm font-medium text-orange-700 hover:underline" to="/admin/zonas-de-envio">Configurar zonas y tarifas</Link> : null}</div>
        </section>
        <section className="form-card">
          <h2 className="form-card-title">Canales de venta</h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div><label className="check-field"><input type="checkbox" checked={form.publicMenuEnabled} onChange={event => change('publicMenuEnabled', event.target.checked)} />Menú publicado</label><p className="mt-2 text-xs text-stone-500">El menú digital se actualiza al guardar.</p></div>
            <div className="sm:border-l sm:border-stone-200 sm:pl-5"><Link className="inline-flex items-center gap-2 text-sm font-semibold text-orange-700 hover:underline" to="/admin/tienda">Configurar tienda online<ArrowUpRight className="h-4 w-4" aria-hidden /></Link><p className="mt-2 text-xs text-stone-500">Publicación, formas de compra y link de tu tienda.</p></div>
          </div>
        </section>
        <details className="admin-disclosure">
          <summary>Apariencia del menú y la tienda</summary>
          <div className="grid gap-4 pt-5 sm:grid-cols-2"><label className="field"><span>Color principal</span><input type="color" value={form.primaryColor} onChange={event => change('primaryColor', event.target.value)} /></label><label className="field"><span>Color secundario</span><input type="color" value={form.secondaryColor} onChange={event => change('secondaryColor', event.target.value)} /></label></div>
          <Link className="mt-4 inline-block text-sm font-medium text-orange-700 hover:underline" to="/admin/marca">Cambiar logo y portada</Link>
        </details>
        <details className="admin-disclosure">
          <summary>Configuración regional e interna</summary>
          <div className="grid gap-4 pt-5 sm:grid-cols-2"><label className="field"><span>Nombre interno</span><input value={form.name} maxLength={120} onChange={event => change('name', event.target.value)} required /></label><label className="field"><span>Zona horaria</span><input value={form.timezone} onChange={event => change('timezone', event.target.value)} /></label><label className="field"><span>Moneda</span><input value={form.currencyCode} maxLength={3} onChange={event => change('currencyCode', event.target.value)} /></label><label className="field"><span>Formato regional</span><input value={form.locale} onChange={event => change('locale', event.target.value)} /></label></div>
        </details>
      </fieldset>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {message ? <p className="form-success" role="status">{message}</p> : null}
      <div className="flex justify-end border-t border-stone-200 pt-5"><button aria-busy={saving} className="button-primary w-full sm:w-auto" disabled={saving} type="submit">{saving ? 'Guardando…' : 'Guardar cambios'}</button></div>
    </form>
  </>
}
