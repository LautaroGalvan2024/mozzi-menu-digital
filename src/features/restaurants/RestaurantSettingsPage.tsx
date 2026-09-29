import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'

interface SettingsForm {
  name: string; tradeName: string; description: string; whatsappPhone: string; address: string; city: string; timezone: string; currencyCode: string; locale: string; primaryColor: string; secondaryColor: string; deliveryEnabled: boolean; pickupEnabled: boolean; minimumOrder: string; preparationMinutes: string; publicMenuEnabled: boolean
}

export function RestaurantSettingsPage() {
  const scope = useRestaurantScope()
  const query = useRestaurant(scope.selected?.id)
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!query.data) return
    setForm({ name: query.data.name, tradeName: query.data.trade_name, description: query.data.description, whatsappPhone: query.data.whatsapp_phone_e164, address: query.data.address, city: query.data.city, timezone: query.data.timezone, currencyCode: query.data.currency_code, locale: query.data.locale, primaryColor: query.data.primary_color, secondaryColor: query.data.secondary_color, deliveryEnabled: query.data.delivery_enabled, pickupEnabled: query.data.pickup_enabled, minimumOrder: (Number(query.data.minimum_order_cents) / 100).toString(), preparationMinutes: query.data.default_preparation_minutes.toString(), publicMenuEnabled: query.data.public_menu_enabled })
  }, [query.data])

  if (query.isLoading) return <LoadingScreen />
  if (query.error) return <ErrorPanel>{query.error.message}</ErrorPanel>
  if (!form) return <LoadingScreen />
  const currentForm = form

  function change<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) { setForm((current) => current ? { ...current, [key]: value } : current) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || !scope.selected) return
    setMessage(null); setError(null)
    const restaurantId = scope.selected.id
    const minimumOrderCents = Math.round(Number(currentForm.minimumOrder.replace(',', '.')) * 100)
    const preparation = Number(currentForm.preparationMinutes)
    if (!Number.isSafeInteger(minimumOrderCents) || minimumOrderCents < 0 || !Number.isInteger(preparation) || preparation < 5 || preparation > 240) { setError('Revisá el pedido mínimo y el tiempo de preparación.'); return }
    if (!currentForm.deliveryEnabled && !currentForm.pickupEnabled) { setError('Habilitá al menos envío o retiro.'); return }
    setSaving(true)
    try {
      const { data, error: updateError } = await supabase.from('restaurants').update({ name: currentForm.name.trim(), trade_name: currentForm.tradeName.trim(), description: currentForm.description.trim(), whatsapp_phone_e164: currentForm.whatsappPhone.trim(), address: currentForm.address.trim(), city: currentForm.city.trim(), timezone: currentForm.timezone.trim(), currency_code: currentForm.currencyCode.trim().toUpperCase(), locale: currentForm.locale.trim(), primary_color: currentForm.primaryColor, secondary_color: currentForm.secondaryColor, delivery_enabled: currentForm.deliveryEnabled, pickup_enabled: currentForm.pickupEnabled, minimum_order_cents: minimumOrderCents, default_preparation_minutes: preparation, public_menu_enabled: currentForm.publicMenuEnabled }).eq('id', restaurantId).select('id').maybeSingle()
      if (updateError) { setError('No se pudo guardar la configuración. Revisá los datos e intentá de nuevo.'); return }
      if (!data || data.id !== restaurantId) { setError('El restaurante cambió o ya no está disponible. Actualizá la vista e intentá nuevamente.'); return }
      setMessage('Configuración guardada.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['restaurant', restaurantId] }),
        queryClient.invalidateQueries({ queryKey: ['restaurant-scope-choices'] }),
        queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
      ])
    } catch {
      setError('No se pudo guardar la configuración. Verificá tu conexión e intentá nuevamente.')
    } finally {
      setSaving(false)
    }
  }

  return <><PageHeader eyebrow="Restaurante" title="Configuración general" description="Los cambios se guardan bajo las políticas RLS del restaurante seleccionado." /><form className="space-y-6" onSubmit={submit}><section className="form-card"><h2 className="form-card-title">Identidad y contacto</h2><div className="grid gap-4 sm:grid-cols-2"><label className="field"><span>Nombre interno</span><input value={form.name} maxLength={120} onChange={(e) => change('name', e.target.value)} required /></label><label className="field"><span>Nombre comercial</span><input value={form.tradeName} maxLength={120} onChange={(e) => change('tradeName', e.target.value)} required /></label><label className="field sm:col-span-2"><span>Descripción</span><textarea rows={3} maxLength={800} value={form.description} onChange={(e) => change('description', e.target.value)} /></label><label className="field"><span>WhatsApp (E.164)</span><input value={form.whatsappPhone} maxLength={20} onChange={(e) => change('whatsappPhone', e.target.value)} required /></label><label className="field"><span>Ciudad</span><input value={form.city} maxLength={100} onChange={(e) => change('city', e.target.value)} required /></label><label className="field sm:col-span-2"><span>Dirección</span><input value={form.address} maxLength={180} onChange={(e) => change('address', e.target.value)} required /></label></div></section><section className="form-card"><h2 className="form-card-title">Operación</h2><div className="grid gap-4 sm:grid-cols-3"><label className="field"><span>Zona horaria</span><input value={form.timezone} onChange={(e) => change('timezone', e.target.value)} /></label><label className="field"><span>Moneda</span><input value={form.currencyCode} maxLength={3} onChange={(e) => change('currencyCode', e.target.value)} /></label><label className="field"><span>Locale</span><input value={form.locale} onChange={(e) => change('locale', e.target.value)} /></label><label className="field"><span>Pedido mínimo</span><input type="number" min="0" step="0.01" value={form.minimumOrder} onChange={(e) => change('minimumOrder', e.target.value)} /></label><label className="field"><span>Preparación (minutos)</span><input type="number" min="5" max="240" value={form.preparationMinutes} onChange={(e) => change('preparationMinutes', e.target.value)} /></label><label className="field"><span>Color principal</span><input type="color" value={form.primaryColor} onChange={(e) => change('primaryColor', e.target.value)} /></label><label className="field"><span>Color secundario</span><input type="color" value={form.secondaryColor} onChange={(e) => change('secondaryColor', e.target.value)} /></label></div><div className="mt-5 flex flex-wrap gap-4"><label className="check-field"><input type="checkbox" checked={form.deliveryEnabled} onChange={(e) => change('deliveryEnabled', e.target.checked)} />Envío habilitado</label><label className="check-field"><input type="checkbox" checked={form.pickupEnabled} onChange={(e) => change('pickupEnabled', e.target.checked)} />Retiro habilitado</label><label className="check-field"><input type="checkbox" checked={form.publicMenuEnabled} onChange={(e) => change('publicMenuEnabled', e.target.checked)} />Menú publicado</label></div></section>{error ? <p className="form-error" role="alert">{error}</p> : null}{message ? <p className="form-success" role="status">{message}</p> : null}<div className="flex justify-end"><button aria-busy={saving} className="button-primary" disabled={saving} type="submit">{saving ? 'Guardando…' : 'Guardar cambios'}</button></div></form></>
}
