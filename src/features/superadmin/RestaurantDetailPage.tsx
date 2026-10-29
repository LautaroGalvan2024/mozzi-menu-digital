import { useQuery,useQueryClient } from '@tanstack/react-query'
import { ArrowLeft,ExternalLink,Settings,Shield,UserCog } from 'lucide-react'
import { useState } from 'react'
import { Link,useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel,LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { invalidateRestaurantStatusQueries } from '../../lib/admin-cache'
import { supabase } from '../../lib/supabase/client'
import { listRestaurantMembers } from '../restaurants/member-directory'
import { persistSelectedRestaurant } from '../restaurants/selection'
import { restaurantSchema } from '../restaurants/useRestaurant'

export function SuperRestaurantDetailPage(){
  const{id}=useParams()
  const client=useQueryClient()
  const[isSaving,setIsSaving]=useState(false)
  const[feedback,setFeedback]=useState<{kind:'error'|'success';message:string}|null>(null)
  const query=useQuery({queryKey:['superadmin-restaurant',id],enabled:z.string().uuid().safeParse(id).success,queryFn:async()=>{const[restaurant,members]=await Promise.all([supabase.from('restaurants').select('*').eq('id',id??'').single(),listRestaurantMembers(id??'')]);if(restaurant.error)throw new Error('No se pudo cargar el comercio.');return{restaurant:restaurantSchema.parse(restaurant.data),members}}})

  if(query.isLoading)return <LoadingScreen/>
  if(query.error||!query.data)return <ErrorPanel>{query.error?.message??'Comercio inexistente.'}</ErrorPanel>
  const{restaurant,members}=query.data

  async function toggle(){
    if(isSaving)return
    const next=restaurant.status==='active'?'suspended':'active'
    if(next==='suspended'&&!window.confirm('¿Suspender este restaurante y su recepción de pedidos?'))return

    setIsSaving(true)
    setFeedback(null)
    try{
      const{data,error}=await supabase
        .from('restaurants')
        .update({status:next})
        .eq('id',restaurant.id)
        .eq('status',restaurant.status)
        .select('id,status')
        .maybeSingle()

      if(error){
        setFeedback({kind:'error',message:'No se pudo actualizar el comercio. Verificá tu sesión y MFA e intentá nuevamente.'})
        return
      }
      if(!data||data.id!==restaurant.id||data.status!==next){
        await client.invalidateQueries({queryKey:['superadmin-restaurant',id]})
        setFeedback({kind:'error',message:'El comercio cambió mientras lo estabas editando. Revisá su estado e intentá nuevamente.'})
        return
      }

      await invalidateRestaurantStatusQueries(client,restaurant.id)
      setFeedback({kind:'success',message:`Comercio ${next==='active'?'activado':'suspendido'} correctamente.`})
    }catch{
      setFeedback({kind:'error',message:'No se pudo actualizar el comercio. Verificá tu conexión e intentá nuevamente.'})
    }finally{
      setIsSaving(false)
    }
  }

  return <><PageHeader eyebrow="Comercio" title={restaurant.trade_name} description={`/${restaurant.slug} · ${restaurant.city} · ${restaurant.status}`} actions={<><Link className="button-secondary" to="/superadmin/restaurantes"><ArrowLeft className="h-4 w-4"/>Volver</Link><Link className="button-secondary" to="/admin" onClick={()=>persistSelectedRestaurant(restaurant.id)}><Settings className="h-4 w-4"/>Administrar</Link><button aria-busy={isSaving} className={restaurant.status==='active'?'button-danger':'button-primary'} disabled={isSaving} onClick={()=>void toggle()} type="button">{isSaving?'Guardando…':restaurant.status==='active'?'Suspender':'Activar'}</button></>}/>{feedback?<p className={`mb-4 rounded-xl p-4 text-sm ${feedback.kind==='error'?'bg-red-50 text-red-800':'bg-emerald-50 text-emerald-800'}`} role={feedback.kind==='error'?'alert':'status'}>{feedback.message}</p>:null}<div className="grid gap-6 lg:grid-cols-[1fr_1fr]"><section className="rounded-xl border border-stone-200 bg-white p-6"><h2 className="font-display text-xl font-bold">Configuración</h2><dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2"><Info label="Dirección" value={`${restaurant.address}, ${restaurant.city}`}/><Info label="WhatsApp" value={restaurant.whatsapp_phone_e164}/><Info label="Zona horaria" value={restaurant.timezone}/><Info label="Moneda" value={restaurant.currency_code}/><Info label="Entrega" value={`${restaurant.delivery_enabled?'Envío ':''}${restaurant.pickup_enabled?'Retiro':''}`}/><Info label="Menú público" value={restaurant.public_menu_enabled?'Publicado':'Sin publicar'}/></dl><a className="button-secondary mt-6" target="_blank" rel="noreferrer" href={`/r/${restaurant.slug}`}><ExternalLink className="h-4 w-4"/>Ver menú</a></section><section className="rounded-xl border border-stone-200 bg-white p-6"><h2 className="font-display text-xl font-bold">Equipo</h2><div className="mt-5 space-y-3">{members.map((member)=><article className="flex items-center gap-3 rounded-xl bg-stone-100 p-3" key={member.id}>{member.role==='restaurant_admin'?<Shield className="h-5 w-5 text-orange-700"/>:<UserCog className="h-5 w-5 text-stone-500"/>}<div className="min-w-0 flex-1"><strong className="block truncate text-sm">{member.profiles?.full_name??'Invitado'}</strong><p className="truncate text-xs text-stone-500">{member.profiles?.email??member.role}</p></div><span className="text-xs text-stone-500">{member.status}</span></article>)}</div></section></div></>}
function Info({label,value}:{label:string;value:string}){return <div><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">{label}</dt><dd className="mt-1 text-stone-700">{value}</dd></div>}
