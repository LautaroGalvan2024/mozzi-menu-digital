import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CreditCard, HandCoins, Plus, Save, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { z } from 'zod'
import { ErrorPanel } from '../../components/Feedback'
import { AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { SectionNavigation } from '../../components/SectionNavigation'
import { useDialogFocus } from '../../components/useDialogFocus'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { MercadoPagoSettings } from './MercadoPagoSettings'
import '../restaurants/settings-workspace.css'

const paymentSections = [
  { id: 'manual', label: 'Pedidos por WhatsApp', icon: HandCoins },
  { id: 'online', label: 'Mercado Pago', icon: CreditCard },
] as const

const schema=z.object({id:z.string().uuid(),restaurant_id:z.string().uuid(),code:z.string(),name:z.string(),description:z.string(),active:z.boolean(),adjustment_type:z.enum(['none','discount','surcharge']),adjustment_scope:z.enum(['subtotal','shipping','total']),adjustment_bps:z.number().int(),adjustment_fixed_cents:z.union([z.string(),z.number()]),transfer_alias:z.string().nullable(),account_holder:z.string().nullable(),bank_name:z.string().nullable(),instructions:z.string().nullable(),sort_order:z.number().int()})
type Row=z.infer<typeof schema>
interface Draft {id?:string;code:string;name:string;description:string;active:boolean;adjustmentType:'none'|'discount'|'surcharge';adjustmentScope:'subtotal'|'shipping'|'total';adjustmentPercent:string;adjustmentFixed:string;transferAlias:string;accountHolder:string;bankName:string;instructions:string;sortOrder:number}
const empty:Draft={code:'',name:'',description:'',active:true,adjustmentType:'none',adjustmentScope:'subtotal',adjustmentPercent:'0',adjustmentFixed:'0',transferAlias:'',accountHolder:'',bankName:'',instructions:'',sortOrder:0}

export function PaymentMethodsPage(){const scope=useRestaurantScope();const restaurant=useRestaurant(scope.selected?.id);const queryClient=useQueryClient();const[draft,setDraft]=useState<Draft|null>(null);const[error,setError]=useState<string|null>(null);const[saving,setSaving]=useState(false);const query=useQuery({queryKey:['payment-methods',scope.selected?.id],enabled:Boolean(scope.selected),queryFn:async()=>{const{data,error:queryError}=await supabase.from('payment_methods').select('*').eq('restaurant_id',scope.selected?.id??'').is('provider',null).order('sort_order');if(queryError)throw new Error('No se pudieron cargar los medios de pago.');return z.array(schema).parse(data)}})
const [section, setSection] = useState<typeof paymentSections[number]['id']>('manual')
const dialog = useRef<HTMLElement>(null)
useDialogFocus(dialog, Boolean(draft), () => { if (!saving) setDraft(null) })
if(query.isLoading||restaurant.isLoading)return <AdminLoading label="Cargando medios de pago…" variant="list" />;if(query.error||restaurant.error)return <ErrorPanel>{query.error?.message??restaurant.error?.message}</ErrorPanel>
function edit(row:Row){setDraft({id:row.id,code:row.code,name:row.name,description:row.description,active:row.active,adjustmentType:row.adjustment_type,adjustmentScope:row.adjustment_scope,adjustmentPercent:(row.adjustment_bps/100).toString(),adjustmentFixed:(Number(row.adjustment_fixed_cents)/100).toString(),transferAlias:row.transfer_alias??'',accountHolder:row.account_holder??'',bankName:row.bank_name??'',instructions:row.instructions??'',sortOrder:row.sort_order})}
function patch<K extends keyof Draft>(key:K,value:Draft[K]){setDraft((current)=>current?{...current,[key]:value}:current)}
async function save(){if(saving||!draft||!scope.selected)return;setError(null);const restaurantId=scope.selected.id;const adjustmentBps=Math.round(Number(draft.adjustmentPercent.replace(',','.'))*100);const fixed=Math.round(Number(draft.adjustmentFixed.replace(',','.'))*100);const code=draft.code.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'-');if(!draft.name.trim()||!code||!Number.isInteger(adjustmentBps)||adjustmentBps<0||adjustmentBps>10000||!Number.isSafeInteger(fixed)||fixed<0||!Number.isInteger(draft.sortOrder)||draft.sortOrder<0){setError('Revisá nombre, código, orden e importes. El porcentaje permitido es 0 a 100.');return}if(draft.adjustmentType==='none'&&(adjustmentBps!==0||fixed!==0)){setError('Si el ajuste es “Ninguno”, el porcentaje y el importe fijo deben ser cero.');return}const payload={restaurant_id:restaurantId,code,name:draft.name.trim(),description:draft.description.trim(),active:draft.active,adjustment_type:draft.adjustmentType,adjustment_scope:draft.adjustmentScope,adjustment_bps:adjustmentBps,adjustment_fixed_cents:fixed,transfer_alias:draft.transferAlias.trim()||null,account_holder:draft.accountHolder.trim()||null,bank_name:draft.bankName.trim()||null,instructions:draft.instructions.trim()||null,sort_order:draft.sortOrder};setSaving(true);try{const result=draft.id?await supabase.from('payment_methods').update(payload).eq('restaurant_id',restaurantId).eq('id',draft.id).select('id,restaurant_id').maybeSingle():await supabase.from('payment_methods').insert(payload).select('id,restaurant_id').single();if(result.error){setError(result.error.code==='23505'?'Ya existe un medio de pago con ese código.':'No se pudo guardar el medio de pago.');return}if(!result.data||result.data.restaurant_id!==restaurantId||(draft.id&&result.data.id!==draft.id)){setError('El medio de pago cambió o ya no está disponible. Actualizá la vista e intentá nuevamente.');return}setDraft(null);await Promise.all([queryClient.invalidateQueries({queryKey:['payment-methods',restaurantId]}),invalidateCatalogQueries(queryClient,restaurantId)])}catch{setError('No se pudo guardar el medio de pago. Verificá tu conexión e intentá nuevamente.')}finally{setSaving(false)}}
return <>
  <PageHeader eyebrow="Configuración" title="Medios de pago" description="Elegí cómo cobrar en tu tienda y en los pedidos por WhatsApp." />
  <SectionNavigation label="Sección de medios de pago" panelPrefix="payment-settings" sections={paymentSections} selected={section} onSelect={setSection} />
  <div id="payment-settings-online" className="settings-panel" hidden={section !== 'online'}>
    {scope.selected ? <MercadoPagoSettings key={scope.selected.id} restaurantId={scope.selected.id} /> : null}
  </div>
  <section id="payment-settings-manual" className="form-card settings-panel" hidden={section !== 'manual'} aria-labelledby="payment-manual-title">
    <div className="settings-panel-heading mb-4">
      <div><h2 id="payment-manual-title" className="form-card-title">Otros medios de pago</h2><p className="settings-panel-description">Opciones para coordinar el pago de los pedidos por WhatsApp.</p></div>
      <button className="button-primary" disabled={saving} onClick={()=>{setError(null);setDraft({...empty,sortOrder:query.data?.length??0})}} type="button"><Plus className="h-4 w-4" aria-hidden/>Nuevo medio</button>
    </div>
    <div className="divide-y divide-stone-100">{query.data?.map((row)=><button key={row.id} disabled={saving} onClick={()=>{setError(null);edit(row)}} className="flex min-h-16 w-full flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-stone-50" type="button">
      <div className="min-w-0"><h3 className="text-sm font-semibold text-stone-900">{row.name}</h3>{row.description?<p className="settings-help mt-1">{row.description}</p>:null}<p className="settings-help mt-1">{row.adjustment_type==='none'?'Sin descuento ni recargo':<>{row.adjustment_type==='discount'?'Descuento':'Recargo'} {row.adjustment_bps/100}%{Number(row.adjustment_fixed_cents)>0?' + '+formatMoney(row.adjustment_fixed_cents,restaurant.data?.currency_code,restaurant.data?.locale):''}</>}</p></div>
      <div className="flex items-center gap-3"><span className={`status-badge ${row.active ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-200 bg-stone-100 text-stone-600'}`}>{row.active?'Activo':'Inactivo'}</span><span className="text-sm font-medium text-[var(--admin-accent-strong)]">Editar</span></div>
    </button>)}</div>
    {!query.data?.length?<p className="py-4 text-sm text-stone-500">Agregá efectivo, transferencia u otra opción para tus clientes.</p>:null}
  </section>
  {draft?<div className="modal-backdrop" role="presentation"><section ref={dialog} tabIndex={-1} className="modal-card settings-form-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-title">
    <header className="settings-dialog-header"><h2 id="payment-title" className="font-display text-xl font-semibold">{draft.id?'Editar':'Nuevo'} medio de pago</h2><button className="icon-button" disabled={saving} onClick={()=>setDraft(null)} aria-label="Cerrar" type="button"><X aria-hidden /></button></header>
    <div className="settings-dialog-body">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="field"><span>Nombre</span><input value={draft.name} maxLength={80} onChange={(e)=>patch('name',e.target.value)}/></label>
      <label className="field"><span>Código</span><input value={draft.code} maxLength={40} onChange={(e)=>patch('code',e.target.value)}/></label>
      <label className="field sm:col-span-2"><span>Descripción</span><input value={draft.description} maxLength={200} onChange={(e)=>patch('description',e.target.value)}/></label>
      <label className="check-field settings-option"><input type="checkbox" checked={draft.active} onChange={(e)=>patch('active',e.target.checked)}/>Activo</label>
    </div>
    <details className="admin-disclosure mt-5" open={draft.adjustmentType!=='none'||undefined}><summary>Descuentos y recargos</summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="field"><span>Ajuste</span><select value={draft.adjustmentType} onChange={(e)=>{const adjustmentType=e.target.value as Draft['adjustmentType'];setDraft((current)=>current?{...current,adjustmentType,...(adjustmentType==='none'?{adjustmentPercent:'0',adjustmentFixed:'0'}:{})}:current)}}><option value="none">Ninguno</option><option value="discount">Descuento</option><option value="surcharge">Recargo</option></select></label>
        <label className="field"><span>Aplicar sobre</span><select value={draft.adjustmentScope} onChange={(e)=>patch('adjustmentScope',e.target.value as Draft['adjustmentScope'])}><option value="subtotal">Subtotal</option><option value="shipping">Envío</option><option value="total">Total</option></select></label>
        <label className="field"><span>Porcentaje</span><input disabled={draft.adjustmentType==='none'} type="number" min="0" max="100" step="0.01" value={draft.adjustmentPercent} onChange={(e)=>patch('adjustmentPercent',e.target.value)}/></label>
        <label className="field"><span>Importe fijo</span><input disabled={draft.adjustmentType==='none'} type="number" min="0" step="0.01" value={draft.adjustmentFixed} onChange={(e)=>patch('adjustmentFixed',e.target.value)}/></label>
      </div>
    </details>
    <details className="admin-disclosure mt-3" open={Boolean(draft.transferAlias||draft.accountHolder||draft.bankName||draft.instructions)||undefined}><summary>Datos para transferencia e instrucciones</summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="field"><span>Alias</span><input value={draft.transferAlias} maxLength={100} onChange={(e)=>patch('transferAlias',e.target.value)}/></label>
        <label className="field"><span>Titular</span><input value={draft.accountHolder} maxLength={120} onChange={(e)=>patch('accountHolder',e.target.value)}/></label>
        <label className="field"><span>Banco</span><input value={draft.bankName} maxLength={100} onChange={(e)=>patch('bankName',e.target.value)}/></label>
        <label className="field sm:col-span-2"><span>Instrucciones</span><textarea rows={2} value={draft.instructions} maxLength={500} onChange={(e)=>patch('instructions',e.target.value)}/></label>
      </div>
    </details>
    </div>
    <footer className="settings-dialog-footer">
      {error?<p className="form-error" role="alert">{error}</p>:null}
      <div className="settings-dialog-actions"><button className="button-secondary" disabled={saving} onClick={()=>setDraft(null)} type="button">Cancelar</button><button aria-busy={saving} className="button-primary" disabled={saving} onClick={()=>void save()} type="button"><Save className="h-4 w-4" aria-hidden />{saving?'Guardando…':'Guardar'}</button></div>
    </footer>
  </section></div>:null}
</>
}
