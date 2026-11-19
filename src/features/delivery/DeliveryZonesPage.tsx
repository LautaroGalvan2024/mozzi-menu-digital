import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Plus, Save, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { formatMoney, parsePriceCents } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { useStageOneFeatures } from '../restaurants/stage-one-features'
import { loadDeliverySchedules, saveDeliveryZone } from './delivery-api'
import { DeliverySchedule, emptyDeliveryPolicy, type DeliveryPolicyInput, type DeliverySchedulePolicy } from './delivery-schedule'
import { DeliveryScheduleFields } from './DeliveryScheduleFields'

const zoneSchema = z.object({
  id: z.string().uuid(), restaurant_id: z.string().uuid(), name: z.string(), description: z.string(),
  delivery_fee_cents: z.union([z.number(), z.string()]), minimum_order_cents: z.union([z.number(), z.string()]),
  free_shipping_from_cents: z.union([z.number(), z.string()]).nullable(), active: z.boolean(), sort_order: z.number().int(),
})
type DeliveryZone = z.infer<typeof zoneSchema>
type ZoneDraft = { name: string; description: string; fee: string; minimum: string; freeFrom: string; active: boolean; sortOrder: number }

export function DeliveryZonesPage() {
  const { selected } = useRestaurantScope()
  return selected ? <DeliveryZonesWorkspace key={selected.id} restaurantId={selected.id} /> : <LoadingScreen />
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
  if (query.isLoading || restaurant.isLoading || loadingFeatures || scheduleQuery.isLoading) return <LoadingScreen />
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
    {message ? <p className="form-success mb-4" role="status">{message}</p> : null}
    {!zones.length ? <p className="surface-card p-5 text-sm text-stone-600">Creá tu primera zona de envío.{schedulingEnabled ? ' Los días de reparto son opcionales.' : ''}</p> : null}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{zones.map(zone => {
      const policy = schedules.find(item => item.zoneId === zone.id)
      return <button key={zone.id} onClick={() => { setMessage(''); setEditing(zone) }} className="surface-card p-5 text-left hover:border-orange-400" type="button">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-stone-100 text-stone-500"><MapPin className="h-5 w-5" /></span>
        <h2 className="mt-4 font-display text-xl font-bold">{zone.name}</h2><p className="mt-1 text-sm text-stone-500">{zone.description}</p>
        <dl className="mt-4 space-y-1 text-sm"><div className="flex justify-between"><dt>Envío</dt><dd className="font-semibold">{formatMoney(zone.delivery_fee_cents, currency, locale)}</dd></div><div className="flex justify-between"><dt>Mínimo</dt><dd>{formatMoney(zone.minimum_order_cents, currency, locale)}</dd></div>{zone.free_shipping_from_cents !== null ? <div className="flex justify-between"><dt>Gratis desde</dt><dd>{formatMoney(zone.free_shipping_from_cents, currency, locale)}</dd></div> : null}</dl>
        {schedulingEnabled ? <p className="mt-3 text-xs text-stone-500">{!zone.active ? 'Zona inactiva' : policy?.menuEnabled || policy?.storeEnabled ? 'Con días de reparto' : 'Entrega a coordinar'}</p> : null}
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
  const dialog = useRef<HTMLElement>(null)
  const busy = useRef(false)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose }, [onClose])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy.current) close.current()
      if (event.key !== 'Tab') return
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button,input,select,textarea,summary') ?? []).filter(item => {
        if (item.matches(':disabled')) return false
        let parent = item.parentElement
        while (parent && parent !== dialog.current) {
          if (parent instanceof HTMLDetailsElement && !parent.open && item.tagName !== 'SUMMARY') return false
          parent = parent.parentElement
        }
        return true
      })
      const first = items[0]; const last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [])

  function patch<K extends keyof ZoneDraft>(key: K, value: ZoneDraft[K]) { setDraft(current => ({ ...current, [key]: value })) }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy.current) return
    setError('')
    const fee = parsePriceCents(draft.fee); const minimum = parsePriceCents(draft.minimum)
    const freeFrom = draft.freeFrom.trim() === '' ? null : parsePriceCents(draft.freeFrom)
    if (!draft.name.trim() || fee === null || minimum === null || (draft.freeFrom.trim() !== '' && freeFrom === null)) { setError('Revisá el nombre y los importes. Usá hasta dos decimales.'); return }
    let validated: DeliveryPolicyInput | null
    try { validated = schedulingEnabled ? new DeliverySchedule(calendar).toInput() : null }
    catch (failure) { setError(failure instanceof z.ZodError ? failure.issues[0]?.message ?? 'Revisá los días de reparto.' : 'Revisá los días de reparto.'); return }
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

  return <div className="modal-backdrop"><section ref={dialog} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delivery-zone-title">
    <div className="flex justify-between gap-4"><h2 id="delivery-zone-title" className="font-display text-2xl font-bold">{zone ? 'Editar zona' : 'Nueva zona'}</h2><button className="icon-button" disabled={saving} onClick={onClose} aria-label="Cerrar" type="button"><X /></button></div>
    <form onSubmit={save} noValidate><fieldset disabled={saving}>
      <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="field sm:col-span-2"><span>Nombre</span><input maxLength={120} value={draft.name} onChange={event => patch('name', event.target.value)} placeholder="Ej.: Centro" /></label><label className="field sm:col-span-2"><span>Descripción</span><input maxLength={1000} value={draft.description} onChange={event => patch('description', event.target.value)} /></label><label className="field"><span>Costo de envío</span><input inputMode="decimal" value={draft.fee} onChange={event => patch('fee', event.target.value)} /></label><label className="field"><span>Pedido mínimo</span><input inputMode="decimal" value={draft.minimum} onChange={event => patch('minimum', event.target.value)} /></label><label className="field"><span>Envío gratis desde</span><input inputMode="decimal" value={draft.freeFrom} onChange={event => patch('freeFrom', event.target.value)} placeholder="Sin promoción" /></label><label className="check-field"><input type="checkbox" checked={draft.active} onChange={event => patch('active', event.target.checked)} />Activa</label></div>
      {schedulingEnabled ? <DeliveryScheduleFields value={calendar} onChange={setCalendar} timezone={timezone} zones={zones.filter(item => item.id !== zoneId)} copyZoneIds={copyZoneIds} onCopyChange={setCopyZoneIds} /> : null}
    </fieldset>
    {error ? <p className="form-error mt-4" role="alert">{error}</p> : null}
    <div className="mt-6 flex justify-end gap-2"><button className="button-secondary" disabled={saving} onClick={onClose} type="button">Cancelar</button><button aria-busy={saving} className="button-primary" disabled={saving} type="submit"><Save className="h-4 w-4" />{saving ? 'Guardando…' : 'Guardar zona'}</button></div></form>
  </section></div>
}
