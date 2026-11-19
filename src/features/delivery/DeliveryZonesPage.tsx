import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, MapPin, Plus, Save, X } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { EmptyState, ErrorPanel } from '../../components/Feedback'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { SectionNavigation } from '../../components/SectionNavigation'
import { useDialogFocus } from '../../components/useDialogFocus'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { formatMoney, parsePriceCents } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { useStageOneFeatures } from '../restaurants/stage-one-features'
import { loadDeliverySchedules, saveDeliveryZone } from './delivery-api'
import { DeliverySchedule, emptyDeliveryPolicy, type DeliveryPolicyInput, type DeliverySchedulePolicy } from './delivery-schedule'
import { DeliveryScheduleFields } from './DeliveryScheduleFields'
import '../restaurants/settings-workspace.css'

const zoneSections = [
  { id: 'details', label: 'Zona y tarifas', icon: MapPin },
  { id: 'calendar', label: 'Calendario de reparto', icon: CalendarClock },
] as const
type ZoneSection = typeof zoneSections[number]['id']

const zoneSchema = z.object({
  id: z.string().uuid(), restaurant_id: z.string().uuid(), name: z.string(), description: z.string(),
  delivery_fee_cents: z.union([z.number(), z.string()]), minimum_order_cents: z.union([z.number(), z.string()]),
  free_shipping_from_cents: z.union([z.number(), z.string()]).nullable(), active: z.boolean(), sort_order: z.number().int(),
})
type DeliveryZone = z.infer<typeof zoneSchema>
type ZoneDraft = { name: string; description: string; fee: string; minimum: string; freeFrom: string; active: boolean; sortOrder: number }

export function DeliveryZonesPage() {
  const { selected } = useRestaurantScope()
  return selected ? <DeliveryZonesWorkspace key={selected.id} restaurantId={selected.id} /> : <AdminLoading label="Cargando zonas de envío…" variant="list" />
}

function DeliveryZonesWorkspace({ restaurantId }: { restaurantId: string }) {
  const restaurant = useRestaurant(restaurantId)
  const { features, loading: loadingFeatures } = useStageOneFeatures(restaurantId)
  const schedulingEnabled = features.delivery_schedule
  const client = useQueryClient()
  const [editing, setEditing] = useState<DeliveryZone | 'new' | null>(null)
  const [message, setMessage] = useState('')
  const query = useQuery({
    queryKey: ['delivery-zones', restaurantId],
    queryFn: async () => {
      const zones = await supabase.from('delivery_zones').select('*').eq('restaurant_id', restaurantId).order('sort_order')
      if (zones.error) throw new Error('No se pudieron cargar las zonas.')
      return z.array(zoneSchema).parse(zones.data)
    },
  })
  const scheduleQuery = useQuery({
    queryKey: ['delivery-schedules', restaurantId],
    enabled: schedulingEnabled,
    queryFn: () => loadDeliverySchedules(restaurantId),
  })
  if (query.isLoading || restaurant.isLoading || loadingFeatures || scheduleQuery.isLoading) return <AdminLoading label="Cargando zonas de envío…" variant="list" />
  const loadError = query.error ?? restaurant.error ?? (schedulingEnabled ? scheduleQuery.error : null)
  if (loadError || !query.data) return <ErrorPanel action={<button className="button-secondary" type="button" onClick={() => void Promise.all([
    query.refetch(), restaurant.refetch(), ...(schedulingEnabled ? [scheduleQuery.refetch()] : []),
  ])}>Volver a intentar</button>}>{loadError?.message ?? 'No se pudieron cargar las zonas.'}</ErrorPanel>
  const zones = query.data
  const schedules = schedulingEnabled ? scheduleQuery.data ?? [] : []
  const currency = restaurant.data?.currency_code
  const locale = restaurant.data?.locale

  async function saved(copied: number) {
    setEditing(null)
    setMessage(copied > 1 ? `Zona guardada. El calendario se aplicó a ${copied} zonas.` : 'Zona guardada.')
    await Promise.all([
      client.invalidateQueries({ queryKey: ['delivery-zones', restaurantId] }),
      client.invalidateQueries({ queryKey: ['delivery-schedules', restaurantId] }),
      client.invalidateQueries({ queryKey: ['delivery-estimate'] }),
      invalidateCatalogQueries(client, restaurantId),
    ])
  }
  return <>
    <PageHeader eyebrow="Logística" title="Zonas de envío" description={schedulingEnabled ? 'Definí dónde entregás, el costo y, si querés, los días de reparto.' : 'Definí dónde entregás y cuánto cuesta el envío.'} actions={<button className="button-primary" type="button" onClick={() => { setMessage(''); setEditing('new') }}><Plus className="h-4 w-4" />Nueva zona</button>} />
    {message ? <InlineFeedback tone="success" className="mb-4">{message}</InlineFeedback> : null}
    {!zones.length ? <EmptyState title="No hay zonas de envío" description={schedulingEnabled ? 'Creá una zona para definir la tarifa. Los días de reparto son opcionales.' : 'Creá una zona para delimitar dónde entregás y cuánto cuesta el envío.'} /> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{zones.map(zone => {
      const policy = schedules.find(item => item.zoneId === zone.id)
      return <button key={zone.id} onClick={() => { setMessage(''); setEditing(zone) }} className="surface-card zone-summary-card min-w-0 p-4 text-left" type="button">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 font-display text-base font-bold"><MapPin className="h-4 w-4 shrink-0" aria-hidden /><span className="wrap-anywhere">{zone.name}</span></h2>
          <span className={`status-badge ${zone.active ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-200 bg-stone-100 text-stone-600'}`}>{zone.active ? 'Zona activa' : 'Zona inactiva'}</span>
        </div>
        {zone.description ? <p className="settings-help mt-1">{zone.description}</p> : null}
        <dl className="mt-3 space-y-1 border-t border-stone-200 pt-2 text-sm"><div className="flex flex-wrap justify-between gap-x-3"><dt>Envío</dt><dd className="font-semibold">{formatMoney(zone.delivery_fee_cents, currency, locale)}</dd></div><div className="flex flex-wrap justify-between gap-x-3"><dt>Mínimo</dt><dd>{formatMoney(zone.minimum_order_cents, currency, locale)}</dd></div>{zone.free_shipping_from_cents !== null ? <div className="flex flex-wrap justify-between gap-x-3"><dt>Gratis desde</dt><dd>{formatMoney(zone.free_shipping_from_cents, currency, locale)}</dd></div> : null}</dl>
        {schedulingEnabled && zone.active ? <p className="settings-help mt-2">{policy?.menuEnabled || policy?.storeEnabled ? 'Con días de reparto' : 'Entrega a coordinar'}</p> : null}
      </button>
    })}</div>
    {editing ? <DeliveryZoneForm key={editing === 'new' ? 'new' : editing.id} restaurantId={restaurantId} zone={editing === 'new' ? null : editing} zones={zones} policy={schedules.find(item => editing !== 'new' && item.zoneId === editing.id)} schedulingEnabled={schedulingEnabled} timezone={restaurant.data?.timezone ?? 'America/Argentina/Cordoba'} onClose={() => setEditing(null)} onSaved={saved} /> : null}
  </>
}

export function DeliveryZoneForm({ restaurantId, zone, zones, policy, schedulingEnabled, timezone, onClose, onSaved }: {
  restaurantId: string; zone: DeliveryZone | null; zones: DeliveryZone[]; policy: DeliverySchedulePolicy | undefined
  schedulingEnabled: boolean; timezone: string; onClose: () => void; onSaved: (count: number) => Promise<void>
}) {
  const [zoneId] = useState(() => zone?.id ?? crypto.randomUUID())
  const [draft, setDraft] = useState<ZoneDraft>(() => zone ? {
    name: zone.name, description: zone.description, fee: (Number(zone.delivery_fee_cents) / 100).toString(),
    minimum: (Number(zone.minimum_order_cents) / 100).toString(), freeFrom: zone.free_shipping_from_cents === null ? '' : (Number(zone.free_shipping_from_cents) / 100).toString(), active: zone.active, sortOrder: zone.sort_order,
  } : { name: '', description: '', fee: '0', minimum: '0', freeFrom: '', active: true, sortOrder: zones.length })
  const [calendar, setCalendar] = useState<DeliveryPolicyInput>(() => policy ? {
    menuEnabled: policy.menuEnabled, storeEnabled: policy.storeEnabled, weekdays: [...policy.weekdays],
    cutoffTime: policy.cutoffTime, cutoffDayOffset: policy.cutoffDayOffset, closedDates: [...policy.closedDates],
  } : emptyDeliveryPolicy())
  const [copyZoneIds, setCopyZoneIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<ZoneSection>('details')
  const [issueSection, setIssueSection] = useState<ZoneSection | null>(null)
  const dialog = useRef<HTMLElement>(null)
  const busy = useRef(false)
  useDialogFocus(dialog, true, () => { if (!busy.current) onClose() })

  function patch<K extends keyof ZoneDraft>(key: K, value: ZoneDraft[K]) { setDraft(current => ({ ...current, [key]: value })) }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy.current) return
    setError('')
    setIssueSection(null)
    const fee = parsePriceCents(draft.fee); const minimum = parsePriceCents(draft.minimum)
    const freeFrom = draft.freeFrom.trim() === '' ? null : parsePriceCents(draft.freeFrom)
    if (!draft.name.trim() || fee === null || minimum === null || (draft.freeFrom.trim() !== '' && freeFrom === null)) {
      showIssue('details', 'Revisá el nombre y los importes. Usá hasta dos decimales.', !draft.name.trim() ? 'zone-name' : fee === null ? 'zone-fee' : minimum === null ? 'zone-minimum' : 'zone-free-from')
      return
    }
    let validated: DeliveryPolicyInput | null
    try { validated = schedulingEnabled ? new DeliverySchedule(calendar).toInput() : null }
    catch (failure) { showIssue('calendar', failure instanceof z.ZodError ? failure.issues[0]?.message ?? 'Revisá los días de reparto.' : 'Revisá los días de reparto.', 'zone-calendar-heading'); return }
    busy.current = true; setSaving(true)
    try {
      const result = await saveDeliveryZone({ restaurantId, zoneId, zone: {
        name: draft.name.trim(), description: draft.description.trim(), deliveryFeeCents: fee,
        minimumOrderCents: minimum, freeShippingFromCents: freeFrom, active: draft.active, sortOrder: draft.sortOrder,
      }, policy: validated, copyZoneIds: schedulingEnabled ? copyZoneIds : [], expectedRevision: policy?.revision ?? 0 })
      await onSaved(result.saved)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos guardar la zona.') }
    finally { busy.current = false; setSaving(false) }
  }

  function showIssue(current: ZoneSection, text: string, focusId: string) {
    setSection(current)
    setIssueSection(current)
    setError(text)
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>(`#${focusId}`)?.focus())
  }

  return <div className="modal-backdrop"><section ref={dialog} tabIndex={-1} className="modal-card settings-form-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-zone-title">
    <header className="settings-dialog-header"><h2 id="delivery-zone-title" className="font-display text-xl font-bold">{zone ? 'Editar zona' : 'Nueva zona'}</h2><button className="icon-button" disabled={saving} onClick={onClose} aria-label="Cerrar" type="button"><X aria-hidden /></button></header>
    <form className="settings-dialog-form" onSubmit={save} noValidate>
      <div className="settings-dialog-body">
        {schedulingEnabled ? <SectionNavigation label="Sección de la zona" panelPrefix="delivery-zone" sections={zoneSections} selected={section} onSelect={setSection} invalidSections={issueSection ? new Set([issueSection]) : undefined} /> : null}
        <fieldset disabled={saving}>
          <div id="delivery-zone-details" className="settings-panel" hidden={section !== 'details'}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field sm:col-span-2"><span>Nombre</span><input id="zone-name" maxLength={120} value={draft.name} onChange={event => patch('name', event.target.value)} placeholder="Ej.: Centro" /></label>
              <label className="field sm:col-span-2"><span>Descripción</span><input maxLength={1000} value={draft.description} onChange={event => patch('description', event.target.value)} /></label>
              <label className="field"><span>Costo de envío</span><input id="zone-fee" inputMode="decimal" value={draft.fee} onChange={event => patch('fee', event.target.value)} /></label>
              <label className="field"><span>Pedido mínimo</span><input id="zone-minimum" inputMode="decimal" value={draft.minimum} onChange={event => patch('minimum', event.target.value)} /></label>
              <label className="field"><span>Envío gratis desde</span><input id="zone-free-from" inputMode="decimal" value={draft.freeFrom} onChange={event => patch('freeFrom', event.target.value)} placeholder="Sin promoción" /></label>
              <label className="check-field settings-option self-end"><input type="checkbox" checked={draft.active} onChange={event => patch('active', event.target.checked)} />Activa</label>
            </div>
          </div>
          {schedulingEnabled ? <div id="delivery-zone-calendar" className="settings-panel" hidden={section !== 'calendar'}>
            <h3 id="zone-calendar-heading" className="sr-only" tabIndex={-1}>Calendario de reparto</h3>
            <DeliveryScheduleFields value={calendar} onChange={setCalendar} timezone={timezone} zones={zones.filter(item => item.id !== zoneId)} copyZoneIds={copyZoneIds} onCopyChange={setCopyZoneIds} />
          </div> : null}
        </fieldset>
      </div>
      <footer className="settings-dialog-footer">
        {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
        <div className="settings-dialog-actions"><button className="button-secondary" disabled={saving} onClick={onClose} type="button">Cancelar</button><button aria-busy={saving} className="button-primary" disabled={saving} type="submit"><Save className="h-4 w-4" aria-hidden />{saving ? 'Guardando…' : 'Guardar zona'}</button></div>
      </footer>
    </form>
  </section></div>
}
