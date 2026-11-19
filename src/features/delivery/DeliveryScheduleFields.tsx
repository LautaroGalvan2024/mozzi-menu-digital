import { useEffect, useId, useState } from 'react'
import { DeliverySchedule, formatDeliveryDate, isCalendarDate, weekdays, type DeliveryPolicyInput } from './delivery-schedule'

export function DeliveryScheduleFields({ value, onChange, timezone, zones, copyZoneIds, onCopyChange }: {
  value: DeliveryPolicyInput; onChange: (next: DeliveryPolicyInput) => void; timezone: string
  zones: Array<{ id: string; name: string }>; copyZoneIds: string[]; onCopyChange: (ids: string[]) => void
}) {
  const fieldId = useId()
  const [closedDate, setClosedDate] = useState('')
  const [dateError, setDateError] = useState('')
  const [previewNow, setPreviewNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setPreviewNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const enabled = value.menuEnabled || value.storeEnabled
  let preview: string | null = null
  try { preview = new DeliverySchedule(value).nextDate(previewNow, timezone) } catch { /* Incomplete draft has no preview. */ }
  function change<K extends keyof DeliveryPolicyInput>(key: K, next: DeliveryPolicyInput[K]) { onChange({ ...value, [key]: next }) }
  function addClosure() {
    if (!isCalendarDate(closedDate)) { setDateError('Elegí una fecha válida.'); return }
    if (value.closedDates.length >= 60) { setDateError('Podés cargar hasta 60 fechas sin reparto.'); return }
    change('closedDates', [...new Set([...value.closedDates, closedDate])].sort())
    setClosedDate(''); setDateError('')
  }
  return <section className="mt-6 border-t border-stone-200 pt-5" aria-labelledby={`${fieldId}-title`}>
    <h3 id={`${fieldId}-title`} className="font-semibold">Días de reparto</h3>
    <label className="check-field mt-3"><input type="checkbox" checked={enabled} onChange={event => onChange({ ...value, menuEnabled: event.target.checked, storeEnabled: event.target.checked })} />Mostrar la próxima entrega estimada</label>
    {!enabled ? <p className="mt-2 text-sm text-stone-500">Opcional. Los pedidos siguen funcionando como hasta ahora.</p> : <>
      <fieldset className="mt-4"><legend className="mb-2 text-sm font-medium">Entrego estos días</legend><div className="flex flex-wrap gap-2">{weekdays.map(day => <label className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${value.weekdays.includes(day.value) ? 'border-orange-500 bg-orange-50' : 'border-stone-300'}`} key={day.value}><input className="mr-1.5" type="checkbox" aria-label={day.label} checked={value.weekdays.includes(day.value)} onChange={event => change('weekdays', event.target.checked ? [...value.weekdays, day.value] : value.weekdays.filter(item => item !== day.value))} />{day.short}</label>)}</div></fieldset>
      <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="field"><span>Recibo pedidos hasta las</span><input type="time" value={value.cutoffTime} onChange={event => change('cutoffTime', event.target.value)} /></label><label className="field"><span>Para el reparto del</span><select value={value.cutoffDayOffset} onChange={event => change('cutoffDayOffset', Number(event.target.value) as 0 | 1)}><option value={1}>Día siguiente</option><option value={0}>Mismo día</option></select></label></div>
      <p className="mt-2 text-xs text-stone-500">Después de esa hora, la estimación pasa al siguiente día de reparto. No cambia tu horario de atención.</p>
      <div className="mt-4 rounded-xl bg-orange-50 p-3 text-sm" role="status">{!value.weekdays.length ? 'Elegí los días para ver un ejemplo.' : preview ? <>Si te compran ahora: <strong>{formatDeliveryDate(preview)}</strong>. El comercio confirma la fecha.</> : 'La entrega quedará a coordinar con el comercio.'}</div>
      <details className="mt-4 rounded-xl border border-stone-200 p-3"><summary className="cursor-pointer text-sm font-medium">Excepciones y dónde mostrarlo</summary>
        <fieldset className="mt-4"><legend className="mb-2 text-sm font-medium">Mostrar en</legend><div className="flex flex-wrap gap-4"><label className="check-field"><input type="checkbox" checked={value.menuEnabled} onChange={event => change('menuEnabled', event.target.checked)} />Menú</label><label className="check-field"><input type="checkbox" checked={value.storeEnabled} onChange={event => change('storeEnabled', event.target.checked)} />Tienda online</label></div></fieldset>
        <div className="mt-4 flex flex-wrap items-end gap-2"><label className="field flex-1"><span>Fecha sin reparto</span><input type="date" value={closedDate} onChange={event => { setClosedDate(event.target.value); setDateError('') }} /></label><button className="button-secondary" type="button" onClick={addClosure}>Agregar cierre</button></div>
        {dateError ? <p className="form-error mt-2" role="alert">{dateError}</p> : null}
        {value.closedDates.length ? <ul className="mt-3 space-y-2">{value.closedDates.map(date => <li className="flex items-center justify-between gap-3 text-sm" key={date}><span>{formatDeliveryDate(date)}</span><button className="button-quiet" type="button" aria-label={`Quitar cierre ${date}`} onClick={() => change('closedDates', value.closedDates.filter(item => item !== date))}>Quitar</button></li>)}</ul> : <p className="mt-2 text-xs text-stone-500">Podés agregar feriados o días en los que no vas a repartir.</p>}
      </details>
    </>}
    {zones.length ? <details className="mt-4 rounded-xl border border-stone-200 p-3"><summary className="cursor-pointer text-sm font-medium">Copiar este calendario a otras zonas</summary><p className="mt-2 text-xs text-stone-500">Al guardar, reemplaza solamente los días, el corte y las excepciones. Conserva sus costos y mínimos.</p><div className="mt-3 space-y-2">{zones.map(zone => <label className="check-field" key={zone.id}><input type="checkbox" checked={copyZoneIds.includes(zone.id)} onChange={event => onCopyChange(event.target.checked ? [...copyZoneIds, zone.id] : copyZoneIds.filter(id => id !== zone.id))} />{zone.name}</label>)}</div></details> : null}
  </section>
}
