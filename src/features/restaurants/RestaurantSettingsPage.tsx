import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { ArrowUpRight, Globe2, Palette, ShoppingBag, Store, Truck } from 'lucide-react'
import { Link } from 'react-router'
import { ErrorPanel } from '../../components/Feedback'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { SectionNavigation } from '../../components/SectionNavigation'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'
import './settings-workspace.css'

const panelPrefix = 'restaurant-settings'
const settingsSections = [
  { id: 'identity', label: 'Datos del comercio', icon: Store },
  { id: 'delivery', label: 'Atención y entrega', icon: Truck },
  { id: 'channels', label: 'Canales de venta', icon: ShoppingBag },
  { id: 'appearance', label: 'Apariencia', icon: Palette },
  { id: 'regional', label: 'Configuración regional e interna', icon: Globe2 },
] as const
type SettingsSection = typeof settingsSections[number]['id']
type DeliveryField = 'settings-order-minimum' | 'settings-preparation' | 'settings-pickup'
type ValidationControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

function sectionFor(control: Element) {
  const section = control.closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection
  return settingsSections.find(item => item.id === section)?.id
}

function invalidControls(form: HTMLFormElement) {
  return Array.from(form.querySelectorAll<ValidationControl>('input:invalid, select:invalid, textarea:invalid'))
}

function invalidSections(controls: ValidationControl[]) {
  const sections = new Set<SettingsSection>()
  for (const control of controls) {
    const section = sectionFor(control)
    if (section) sections.add(section)
  }
  return sections
}

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
  const [section, setSection] = useState<SettingsSection>('identity')
  const [nativeIssues, setNativeIssues] = useState<ReadonlySet<SettingsSection>>(new Set())
  const [deliveryIssue, setDeliveryIssue] = useState<DeliveryField | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!query.data || form) return
    const r = query.data
    setForm({ name: r.name, tradeName: r.trade_name, description: r.description, whatsappPhone: r.whatsapp_phone_e164, address: r.address, city: r.city, timezone: r.timezone, currencyCode: r.currency_code, locale: r.locale, primaryColor: r.primary_color, secondaryColor: r.secondary_color, deliveryEnabled: r.delivery_enabled, pickupEnabled: r.pickup_enabled, minimumOrder: (Number(r.minimum_order_cents) / 100).toString(), preparationMinutes: r.default_preparation_minutes.toString(), publicMenuEnabled: r.public_menu_enabled })
  }, [query.data, form])
  if (query.isLoading) return <AdminLoading label="Cargando los datos del comercio…" variant="list" />
  if (query.error) return <ErrorPanel>{query.error.message}</ErrorPanel>
  if (!form) return <AdminLoading label="Cargando los datos del comercio…" variant="list" />
  const currentForm = form
  function change<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) { setForm(current => current ? { ...current, [key]: value } : current); setMessage(null) }

  function revealNativeIssue(event: FormEvent<HTMLFormElement>) {
    const control = event.target
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return
    const invalid = invalidControls(event.currentTarget)
    const panel = sectionFor(control)
    // Hidden sections remain part of the same form and still participate in
    // native validation. Make the first failing field visible before focusing it.
    if (panel && panel !== section) {
      event.preventDefault()
      if (invalid[0] === control) {
        setSection(panel)
        requestAnimationFrame(() => {
          if (!control.isConnected) return
          control.focus()
          control.reportValidity()
        })
      }
    }
    if (invalid[0] === control) setNativeIssues(invalidSections(invalid))
  }

  function showDeliveryIssue(formElement: HTMLFormElement, field: DeliveryField, message: string) {
    setError(message)
    setDeliveryIssue(field)
    setSection('delivery')
    requestAnimationFrame(() => formElement.querySelector<HTMLInputElement>(`#${field}`)?.focus())
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || !restaurantId) return
    setMessage(null); setError(null)
    setNativeIssues(new Set())
    setDeliveryIssue(null)
    const minimumOrderCents = Math.round(Number(currentForm.minimumOrder.replace(',', '.')) * 100)
    const preparation = Number(currentForm.preparationMinutes)
    const invalidMinimum = !Number.isSafeInteger(minimumOrderCents) || minimumOrderCents < 0
    if (invalidMinimum || !Number.isInteger(preparation) || preparation < 5 || preparation > 240) {
      showDeliveryIssue(event.currentTarget, invalidMinimum ? 'settings-order-minimum' : 'settings-preparation', 'Revisá el pedido mínimo y el tiempo de preparación.')
      return
    }
    if (!currentForm.deliveryEnabled && !currentForm.pickupEnabled) {
      showDeliveryIssue(event.currentTarget, 'settings-pickup', 'Habilitá al menos envío o retiro.')
      return
    }
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
        invalidateCatalogQueries(queryClient, restaurantId),
      ])
    } catch { setError('No se pudo guardar la configuración. Verificá tu conexión e intentá nuevamente.') }
    finally { setSaving(false) }
  }

  const issues = deliveryIssue ? new Set([...nativeIssues, 'delivery' as const]) : nativeIssues
  const sectionProps = (id: SettingsSection) => ({
    id: `${panelPrefix}-${id}`,
    hidden: section !== id,
    'data-settings-section': id,
    'aria-labelledby': `${panelPrefix}-${id}-heading`,
  })

  return <>
    <PageHeader title="Configuración general" description="Administrá los datos públicos y las preferencias de tu comercio." />
    <form className="settings-workspace" onSubmit={submit} onInvalidCapture={revealNativeIssue} onInput={event => {
      if (nativeIssues.size) setNativeIssues(invalidSections(invalidControls(event.currentTarget)))
    }}>
      <SectionNavigation label="Sección de configuración" panelPrefix={panelPrefix} sections={settingsSections} selected={section} onSelect={setSection} invalidSections={issues} />
      <fieldset disabled={saving} className="min-w-0">
        <section className="form-card settings-panel" {...sectionProps('identity')}>
          <h2 id={`${panelPrefix}-identity-heading`} className="form-card-title">Datos del comercio</h2>
          <p className="settings-panel-description">Son los datos que ven tus clientes en el menú digital y la tienda.</p>
          <div className="settings-field-grid">
            <label className="field"><span>Nombre comercial</span><input value={form.tradeName} maxLength={120} onChange={event => change('tradeName', event.target.value)} required /></label>
            <div className="field"><label htmlFor="settings-whatsapp">WhatsApp</label><input id="settings-whatsapp" type="tel" autoComplete="tel" aria-describedby="settings-whatsapp-hint" value={form.whatsappPhone} maxLength={20} onChange={event => change('whatsappPhone', event.target.value)} required /><p id="settings-whatsapp-hint" className="settings-help">Incluí el código de país, por ejemplo +5491123456789.</p></div>
            <label className="field"><span>Dirección</span><input autoComplete="street-address" value={form.address} maxLength={180} onChange={event => change('address', event.target.value)} required /></label>
            <label className="field"><span>Ciudad</span><input autoComplete="address-level2" value={form.city} maxLength={100} onChange={event => change('city', event.target.value)} required /></label>
            <label className="field sm:col-span-2"><span>Descripción</span><textarea rows={2} maxLength={800} value={form.description} onChange={event => change('description', event.target.value)} placeholder="Contales a tus clientes qué ofrecés." /></label>
          </div>
        </section>
        <section className="form-card settings-panel" {...sectionProps('delivery')}>
          <div className="settings-panel-heading"><div><h2 id={`${panelPrefix}-delivery-heading`} className="form-card-title">Atención y entrega</h2><p className="settings-panel-description">Definí cómo pueden recibir un pedido tus clientes.</p></div><Link className="button-secondary" to="/admin/horarios">Editar horarios<ArrowUpRight className="h-4 w-4" aria-hidden /></Link></div>
          <div className="settings-field-grid">
            <div className="field"><label htmlFor="settings-order-minimum">Pedido mínimo</label><input id="settings-order-minimum" type="number" min="0" step="0.01" aria-invalid={deliveryIssue === 'settings-order-minimum' || undefined} aria-describedby={deliveryIssue === 'settings-order-minimum' ? 'settings-order-minimum-hint settings-delivery-error' : 'settings-order-minimum-hint'} value={form.minimumOrder} onChange={event => change('minimumOrder', event.target.value)} /><p id="settings-order-minimum-hint" className="settings-help">Importe mínimo del pedido. Ingresá 0 para dejarlo sin mínimo general.</p></div>
            <div className="field"><label htmlFor="settings-preparation">Preparación (minutos)</label><input id="settings-preparation" type="number" min="5" max="240" aria-invalid={deliveryIssue === 'settings-preparation' || undefined} aria-describedby={deliveryIssue === 'settings-preparation' ? 'settings-preparation-hint settings-delivery-error' : 'settings-preparation-hint'} value={form.preparationMinutes} onChange={event => change('preparationMinutes', event.target.value)} /><p id="settings-preparation-hint" className="settings-help">Entre 5 y 240 minutos.</p></div>
          </div>
          <div className="settings-option-group">
            <label className="check-field settings-option"><input id="settings-pickup" type="checkbox" aria-describedby={deliveryIssue === 'settings-pickup' ? 'settings-delivery-error' : undefined} checked={form.pickupEnabled} onChange={event => change('pickupEnabled', event.target.checked)} />Retiro habilitado</label>
            <label className="check-field settings-option"><input type="checkbox" checked={form.deliveryEnabled} onChange={event => change('deliveryEnabled', event.target.checked)} />Envío habilitado</label>
          </div>
          {form.deliveryEnabled ? <Link className="button-quiet settings-related-link" to="/admin/zonas-de-envio">Configurar zonas y tarifas<ArrowUpRight className="h-4 w-4" aria-hidden /></Link> : null}
          {deliveryIssue && error ? <div id="settings-delivery-error"><InlineFeedback tone="error" className="mt-3">{error}</InlineFeedback></div> : null}
        </section>
        <section className="form-card settings-panel" {...sectionProps('channels')}>
          <h2 id={`${panelPrefix}-channels-heading`} className="form-card-title">Canales de venta</h2>
          <div className="settings-field-grid">
            <div className="settings-related-card"><h3>Menú digital</h3><p className="settings-help">Tu menú cambia de estado al guardar esta configuración.</p><label className="check-field min-h-11"><input type="checkbox" checked={form.publicMenuEnabled} onChange={event => change('publicMenuEnabled', event.target.checked)} />Menú publicado</label></div>
            <div className="settings-related-card"><h3>Tienda online</h3><p className="settings-help">Administrá su publicación, sus formas de compra y su enlace.</p><Link className="button-quiet settings-related-link" to="/admin/tienda">Configurar tienda online<ArrowUpRight className="h-4 w-4" aria-hidden /></Link></div>
          </div>
        </section>
        <section className="form-card settings-panel" {...sectionProps('appearance')}>
          <div className="settings-panel-heading"><div><h2 id={`${panelPrefix}-appearance-heading`} className="form-card-title">Apariencia del menú y la tienda</h2><p className="settings-panel-description">Elegí los colores de tus páginas públicas.</p></div><Link className="button-secondary" to="/admin/marca">Cambiar logo y portada<ArrowUpRight className="h-4 w-4" aria-hidden /></Link></div>
          <div className="settings-field-grid">
            <div className="settings-color"><div className="field"><label htmlFor="settings-primary-color">Color principal</label><input id="settings-primary-color" type="color" value={form.primaryColor} onChange={event => change('primaryColor', event.target.value)} /></div><span>{form.primaryColor}</span></div>
            <div className="settings-color"><div className="field"><label htmlFor="settings-secondary-color">Color secundario</label><input id="settings-secondary-color" type="color" value={form.secondaryColor} onChange={event => change('secondaryColor', event.target.value)} /></div><span>{form.secondaryColor}</span></div>
          </div>
        </section>
        <section className="form-card settings-panel" {...sectionProps('regional')}>
          <h2 id={`${panelPrefix}-regional-heading`} className="form-card-title">Configuración regional e interna</h2>
          <div className="settings-field-grid">
            <div className="field"><label htmlFor="settings-name">Nombre interno</label><input id="settings-name" value={form.name} maxLength={120} aria-describedby="settings-name-hint" onChange={event => change('name', event.target.value)} required /><p id="settings-name-hint" className="settings-help">El nombre comercial se edita en Datos del comercio.</p></div>
            <div className="field"><label htmlFor="settings-timezone">Zona horaria</label><input id="settings-timezone" value={form.timezone} aria-describedby="settings-timezone-hint" onChange={event => change('timezone', event.target.value)} /><p id="settings-timezone-hint" className="settings-help">Determina cuándo se aplican los horarios. Por ejemplo, America/Argentina/Buenos_Aires.</p></div>
            <div className="field"><label htmlFor="settings-currency">Moneda</label><input id="settings-currency" value={form.currencyCode} maxLength={3} aria-describedby="settings-currency-hint" onChange={event => change('currencyCode', event.target.value)} /><p id="settings-currency-hint" className="settings-help">Código de la moneda de los importes. Por ejemplo, ARS.</p></div>
            <div className="field"><label htmlFor="settings-locale">Formato regional</label><input id="settings-locale" value={form.locale} aria-describedby="settings-locale-hint" onChange={event => change('locale', event.target.value)} /><p id="settings-locale-hint" className="settings-help">Indica cómo se muestran los importes. Por ejemplo, es-AR.</p></div>
          </div>
        </section>
      </fieldset>
      {error && !deliveryIssue ? <InlineFeedback tone="error" className="mt-3">{error}</InlineFeedback> : null}
      {message ? <InlineFeedback tone="success" className="mt-3">{message}</InlineFeedback> : null}
      <div className="settings-save-bar"><p className="settings-help">Guarda los cambios de todas las secciones de esta configuración.</p><button aria-busy={saving} className="button-primary" disabled={saving} type="submit">{saving ? 'Guardando…' : 'Guardar cambios'}</button></div>
    </form>
  </>
}
