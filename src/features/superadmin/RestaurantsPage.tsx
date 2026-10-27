import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Building2,Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { ErrorPanel,EmptyState,LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { supabase } from '../../lib/supabase/client'

const schema=z.array(z.object({id:z.string().uuid(),name:z.string(),trade_name:z.string(),slug:z.string(),status:z.enum(['draft','active','suspended']),city:z.string(),public_menu_enabled:z.boolean(),created_at:z.string()}))
export function RestaurantsPage(){
  const client=useQueryClient()
  const[pendingId,setPendingId]=useState<string|null>(null)
  const[feedback,setFeedback]=useState<{kind:'error'|'success';message:string}|null>(null)
  const query=useQuery({queryKey:['superadmin-restaurants'],queryFn:async()=>{const{data,error}=await supabase.from('restaurants').select('id,name,trade_name,slug,status,city,public_menu_enabled,created_at').order('created_at',{ascending:false});if(error)throw new Error('No se pudieron cargar los comercios.');return schema.parse(data)}})

  if(query.isLoading)return <LoadingScreen/>
  if(query.error)return <ErrorPanel>{query.error.message}</ErrorPanel>

  async function status(id:string,current:'draft'|'active'|'suspended',next:'active'|'suspended'){
    if(pendingId)return
    if(next==='suspended'&&!window.confirm('¿Suspender el comercio? El menú y la tienda dejarán de aceptar pedidos.'))return

    setPendingId(id)
    setFeedback(null)
    try{
      const{data,error}=await supabase
        .from('restaurants')
        .update({status:next})
        .eq('id',id)
        .eq('status',current)
        .select('id,status')
        .maybeSingle()

      if(error){
        setFeedback({kind:'error',message:'No se pudo actualizar el comercio. Verificá tu sesión y MFA e intentá nuevamente.'})
        return
      }
      if(!data||data.id!==id||data.status!==next){
        await client.invalidateQueries({queryKey:['superadmin-restaurants']})
        setFeedback({kind:'error',message:'El comercio cambió mientras lo estabas editando. Revisá su estado e intentá nuevamente.'})
        return
      }

      await Promise.all([
        client.invalidateQueries({queryKey:['superadmin-restaurants']}),
        client.invalidateQueries({queryKey:['superadmin-restaurant',id]}),
      ])
      setFeedback({kind:'success',message:`Comercio ${next==='active'?'activado':'suspendido'} correctamente.`})
    }catch{
      setFeedback({kind:'error',message:'No se pudo actualizar el comercio. Verificá tu conexión e intentá nuevamente.'})
    }finally{
      setPendingId(null)
    }
  }

  return <><PageHeader eyebrow="Comercios" title="Comercios" description="Creá y administrá los comercios de la plataforma." actions={<Link className="button-primary" to="/superadmin/restaurantes/nuevo"><Plus className="h-4 w-4"/>Nuevo</Link>}/>{feedback?<p className={`mb-4 rounded-xl p-4 text-sm ${feedback.kind==='error'?'bg-red-50 text-red-800':'bg-emerald-50 text-emerald-800'}`} role={feedback.kind==='error'?'alert':'status'}>{feedback.message}</p>:null}{query.data?.length===0?<EmptyState title="Todavía no hay comercios" description="Creá el primer comercio para cargar su catálogo y configurar sus canales de venta."/>:<div className="space-y-3">{query.data?.map((row)=>{const isPending=pendingId===row.id;return <article key={row.id} className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-4 sm:flex-row sm:items-center"><span className="grid h-12 w-12 place-items-center rounded-xl bg-stone-100 text-orange-700"><Building2/></span><div className="min-w-0 flex-1"><Link className="font-display text-lg font-bold hover:text-orange-800" to={`/superadmin/restaurantes/${row.id}`}>{row.trade_name}</Link><p className="text-sm text-stone-500">/{row.slug} · {row.city}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${row.status==='active'?'bg-emerald-50 text-emerald-800':row.status==='suspended'?'bg-red-50 text-red-800':'bg-amber-50 text-amber-800'}`}>{{active:'Activo',draft:'Borrador',suspended:'Suspendido'}[row.status]}</span><button aria-busy={isPending} className={row.status==='active'?'button-danger':'button-secondary'} disabled={pendingId!==null} onClick={()=>void status(row.id,row.status,row.status==='active'?'suspended':'active')} type="button">{isPending?'Guardando…':row.status==='active'?'Suspender':'Activar'}</button></article>})}</div>}</>}
