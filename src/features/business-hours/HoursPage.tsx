import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CalendarDays, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { ErrorPanel } from '../../components/Feedback'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { SectionNavigation } from '../../components/SectionNavigation'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { supabase } from '../../lib/supabase/client'
import { dateInTimeZone } from '../../lib/timezone'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import '../restaurants/settings-workspace.css'

const hourSections = [
  { id: 'weekly', label: 'Horario semanal', icon: CalendarClock },
  { id: 'exceptions', label: 'Fechas especiales', icon: CalendarDays },
] as const
type HourSection = typeof hourSections[number]['id']
const exceptionConflict = 'Un cierre por fecha no se puede combinar con otros turnos especiales.'
const invalidSpecialHours: ReadonlySet<HourSection> = new Set(['exceptions'])

const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']
const slotSchema = z.object({ id:z.string().uuid(), restaurant_id:z.string().uuid(), day_of_week:z.number().int(), slot_index:z.number().int(), opens_at:z.string(), closes_at:z.string(), spans_next_day:z.boolean(), active:z.boolean() })
type Slot = z.infer<typeof slotSchema>
const specialSchema = z.object({ id:z.string().uuid(), restaurant_id:z.string().uuid(), date:z.string(), is_closed:z.boolean(), slot_index:z.number().int(), opens_at:z.string().nullable(), closes_at:z.string().nullable(), spans_next_day:z.boolean(), reason:z.string().nullable() })
type Special = z.infer<typeof specialSchema>

export function HoursPage() {
  const scope=useRestaurantScope(); const restaurant=useRestaurant(scope.selected?.id); const queryClient=useQueryClient(); const [draft,setDraft]=useState<Slot[]|null>(null); const [specials,setSpecials]=useState<Special[]|null>(null); const [saving,setSaving]=useState(false); const [message,setMessage]=useState<string|null>(null); const [error,setError]=useState<string|null>(null)
  const [section, setSection] = useState<HourSection>('weekly')
  useEffect(()=>{setDraft(null);setSpecials(null);setMessage(null);setError(null);setSection('weekly')},[scope.selected?.id])
  const query=useQuery({queryKey:['hours',scope.selected?.id,restaurant.data?.timezone],enabled:Boolean(scope.selected&&restaurant.data),queryFn:async()=>{const today=dateInTimeZone(new Date(),restaurant.data?.timezone??'UTC');const [regular,special]=await Promise.all([supabase.from('business_hours').select('*').eq('restaurant_id',scope.selected?.id??'').order('day_of_week').order('slot_index'),supabase.from('special_hours').select('*').eq('restaurant_id',scope.selected?.id??'').gte('date',today).order('date')]);if(regular.error||special.error)throw new Error('No se pudieron cargar los horarios.');return{regular:z.array(slotSchema).parse(regular.data),special:z.array(specialSchema).parse(special.data)}}})
  const regular=draft??query.data?.regular??[]; const exceptions=specials??query.data?.special??[]
  const originalRegularIds=useMemo(()=>new Set(query.data?.regular.map((slot)=>slot.id)??[]),[query.data?.regular]); const originalSpecialIds=useMemo(()=>new Set(query.data?.special.map((item)=>item.id)??[]),[query.data?.special])
  if(!scope.selected)return <ErrorPanel>Falta seleccionar un restaurante.</ErrorPanel>; if(restaurant.error||query.error)return <ErrorPanel>{restaurant.error?.message??query.error?.message}</ErrorPanel>; if(restaurant.isLoading||query.isLoading||!restaurant.data)return <AdminLoading label="Cargando horarios…" variant="list" />
  function addSlot(day:number){setDraft([...regular,{id:crypto.randomUUID(),restaurant_id:scope.selected!.id,day_of_week:day,slot_index:regular.filter((slot)=>slot.day_of_week===day).length,opens_at:'09:00',closes_at:'13:00',spans_next_day:false,active:true}])}
  function patchSlot(id:string,patch:Partial<Slot>){setDraft(regular.map((slot)=>slot.id===id?{...slot,...patch}:slot))}
  function removeSlot(id:string){setDraft(regular.filter((slot)=>slot.id!==id))}
  function addException(){const date=dateInTimeZone(new Date(),restaurant.data!.timezone);setSpecials([...exceptions,{id:crypto.randomUUID(),restaurant_id:scope.selected!.id,date,is_closed:true,slot_index:exceptions.filter((item)=>item.date===date).length,opens_at:null,closes_at:null,spans_next_day:false,reason:''}])}
  function patchSpecial(id:string,patch:Partial<Special>){setSpecials(exceptions.map((item)=>item.id===id?{...item,...patch}:item))}
  async function save(){
    const restaurantId=scope.selected!.id
    setError(null);setMessage(null)
    const specialDates=new Map<string,Special[]>()
    for(const item of exceptions)specialDates.set(item.date,[...(specialDates.get(item.date)??[]),item])
    if([...specialDates.values()].some((items)=>items.some((item)=>item.is_closed)&&items.length>1)){
      setError(exceptionConflict)
      setSection('exceptions')
      requestAnimationFrame(() => document.getElementById('hours-exception-title')?.focus())
      return
    }
    setSaving(true)
    try{
      if(regular.some((slot)=>slot.restaurant_id!==restaurantId)||exceptions.some((item)=>item.restaurant_id!==restaurantId))throw new Error('TENANT_DRAFT_MISMATCH')
      const regularPayload=regular.map((slot)=>({
        id:slot.id,
        dayOfWeek:slot.day_of_week,
        slotIndex:regular.filter((candidate)=>candidate.day_of_week===slot.day_of_week).findIndex((candidate)=>candidate.id===slot.id),
        opensAt:slot.opens_at.slice(0,5),
        closesAt:slot.closes_at.slice(0,5),
        spansNextDay:slot.spans_next_day,
        active:slot.active,
      }))
      const specialPayload=exceptions.map((item)=>({
        id:item.id,
        date:item.date,
        slotIndex:exceptions.filter((candidate)=>candidate.date===item.date).findIndex((candidate)=>candidate.id===item.id),
        isClosed:item.is_closed,
        opensAt:item.is_closed?null:item.opens_at?.slice(0,5)??null,
        closesAt:item.is_closed?null:item.closes_at?.slice(0,5)??null,
        spansNextDay:item.is_closed?false:item.spans_next_day,
        reason:item.reason?.trim()||null,
      }))
      const deletedRegular=[...originalRegularIds].filter((id)=>!regular.some((slot)=>slot.id===id))
      const deletedSpecial=[...originalSpecialIds].filter((id)=>!exceptions.some((item)=>item.id===id))
      const{error:saveError}=await supabase.rpc('save_restaurant_hours',{
        p_restaurant_id:restaurantId,
        p_regular:regularPayload,
        p_special:specialPayload,
        p_delete_regular_ids:deletedRegular,
        p_delete_special_ids:deletedSpecial,
      })
      if(saveError)throw saveError
      setDraft(null);setSpecials(null)
      await Promise.all([
        queryClient.invalidateQueries({queryKey:['hours',restaurantId]}),
        invalidateCatalogQueries(queryClient,restaurantId),
      ])
      setMessage('Horarios guardados. Se aplican según la zona horaria del comercio.')
    }catch{
      setError('No se pudieron guardar todos los horarios. Volvé a cargar antes de reintentar.')
    }finally{setSaving(false)}
  }
  return <>
    <PageHeader eyebrow="Operación" title="Horarios" description="Definí tus horarios de atención y los cambios para fechas especiales."/>
    <SectionNavigation<HourSection> label="Sección de horarios" panelPrefix="hours" sections={hourSections} selected={section} onSelect={setSection} invalidSections={error === exceptionConflict ? invalidSpecialHours : undefined} />
    <section id="hours-weekly" hidden={section !== 'weekly'} className="settings-panel" aria-label="Horario semanal">
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,21rem),1fr))]">
      {days.map((day,dayIndex)=>{
        const daySlots=regular.filter((slot)=>slot.day_of_week===dayIndex)
        return <section key={day} className="surface-card min-w-0 px-3 py-2 sm:px-4">
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="font-display text-base font-bold text-stone-950 sm:text-lg">{day}</h2>
              <span className={`status-badge ${daySlots.length===0?'border-stone-200 bg-stone-100 text-stone-600':'border-emerald-200 bg-emerald-50 text-emerald-800'}`}><span className={`h-1.5 w-1.5 rounded-full ${daySlots.length===0?'bg-stone-400':'bg-emerald-500'}`} aria-hidden/>{daySlots.length===0?'Cerrado':'Abierto'}</span>
            </div>
            <button type="button" className="button-quiet shrink-0 px-2.5" onClick={()=>addSlot(dayIndex)}><Plus className="h-4 w-4" aria-hidden/>Agregar turno</button>
          </div>
          {daySlots.length>0?<div className="space-y-2 pb-1">{daySlots.map((slot)=><div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-x-2 rounded-lg border border-stone-200 bg-stone-50/70 px-2.5 pt-2.5" key={slot.id}>
            <label className="field"><span>Abre</span><input type="time" value={slot.opens_at.slice(0,5)} onChange={(e)=>patchSlot(slot.id,{opens_at:e.target.value})}/></label>
            <label className="field"><span>Cierra</span><input type="time" value={slot.closes_at.slice(0,5)} onChange={(e)=>patchSlot(slot.id,{closes_at:e.target.value})}/></label>
            <label className="check-field col-span-2 col-start-1 row-start-2 min-h-11"><input type="checkbox" checked={slot.spans_next_day} onChange={(e)=>patchSlot(slot.id,{spans_next_day:e.target.checked})}/>Pasa medianoche</label>
            <button type="button" className="icon-button col-start-3 row-start-1 self-end text-red-700 hover:bg-red-50 hover:text-red-800" aria-label={`Eliminar turno de ${day}`} onClick={()=>removeSlot(slot.id)}><Trash2 className="h-4 w-4" aria-hidden/></button>
          </div>)}</div>:null}
        </section>
      })}
      </div>
    </section>
    <section id="hours-exceptions" className="form-card settings-panel" hidden={section !== 'exceptions'} aria-labelledby="hours-exception-title">
      <div className="settings-panel-heading">
        <div><h2 id="hours-exception-title" className="form-card-title" tabIndex={-1}>Excepciones</h2><p className="settings-panel-description">Usalas cuando un feriado, un cierre o un horario especial cambien un día habitual.</p></div>
        <button type="button" className="button-secondary w-full sm:w-auto" onClick={addException}><Plus className="h-4 w-4" aria-hidden/>Agregar</button>
      </div>
      {exceptions.length === 0 ? <p className="settings-help mt-4">No hay fechas especiales programadas.</p> : null}
      <div className="mt-4 space-y-3">{exceptions.map((item)=><div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-end gap-3 rounded-lg border border-stone-200 bg-stone-50/70 p-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]" key={item.id}>
        <label className="field"><span>Fecha</span><input type="date" value={item.date} onChange={(e)=>patchSpecial(item.id,{date:e.target.value})}/></label>
        <label className="check-field min-h-11"><input type="checkbox" checked={item.is_closed} onChange={(e)=>patchSpecial(item.id,{is_closed:e.target.checked,opens_at:e.target.checked?null:(item.opens_at??'09:00'),closes_at:e.target.checked?null:(item.closes_at??'13:00'),spans_next_day:e.target.checked?false:item.spans_next_day})}/>Cerrado</label>
        <label className="field"><span>Abre</span><input type="time" disabled={item.is_closed} value={item.opens_at?.slice(0,5)??''} onChange={(e)=>patchSpecial(item.id,{opens_at:e.target.value})}/></label>
        <label className="field"><span>Cierra</span><input type="time" disabled={item.is_closed} value={item.closes_at?.slice(0,5)??''} onChange={(e)=>patchSpecial(item.id,{closes_at:e.target.value})}/></label>
        <label className="check-field col-span-2 min-h-11 lg:col-span-1"><input type="checkbox" disabled={item.is_closed} checked={item.spans_next_day} onChange={(e)=>patchSpecial(item.id,{spans_next_day:e.target.checked})}/>Pasa medianoche</label>
        <label className="field col-span-2"><span>Motivo</span><input maxLength={120} value={item.reason??''} onChange={(e)=>patchSpecial(item.id,{reason:e.target.value})}/></label>
        <button type="button" className="icon-button col-span-2 justify-self-end text-red-700 hover:bg-red-50 hover:text-red-800 lg:col-span-1" onClick={()=>setSpecials(exceptions.filter((entry)=>entry.id!==item.id))} aria-label="Eliminar excepción"><Trash2 className="h-4 w-4" aria-hidden/></button>
      </div>)}</div>
    </section>
    {error ? <InlineFeedback tone="error" className="mt-3">{error}</InlineFeedback> : null}
    {message ? <InlineFeedback tone="success" className="mt-3">{message}</InlineFeedback> : null}
    <div className="settings-save-bar"><p className="settings-help">Guarda el horario semanal y las fechas especiales.</p><button type="button" className="button-primary" disabled={saving} aria-busy={saving} onClick={()=>void save()}>{saving?'Guardando…':'Guardar horarios'}</button></div>
  </>
}
