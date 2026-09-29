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
  const query=useQuery({queryKey:['superadmin-restaurants'],queryFn:async()=>{const{data,error}=await supabase.from('restaurants').select('id,name,trade_name,slug,status,city,public_menu_enabled,created_at').order('created_at',{ascending:false});if(error)throw new Error('No se pudieron cargar los restaurantes.');return schema.parse(data)}})

  if(query.isLoading)return <LoadingScreen/>
  if(query.error)return <ErrorPanel>{query.error.message}</ErrorPanel>

  async function status(id:string,current:'draft'|'active'|'suspended',next:'active'|'suspended'){
    if(pendingId)return
    if(next==='suspended'&&!window.confirm('¿Suspender el restaurante? Su menú dejará de aceptar pedidos.'))return

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
        setFeedback({kind:'error',message:'No se pudo actualizar el restaurante. Verificá tu sesión y MFA e intentá nuevamente.'})
        return
      }
      if(!data||data.id!==id||data.status!==next){
        await client.invalidateQueries({queryKey:['superadmin-restaurants']})
        setFeedback({kind:'error',message:'El restaurante cambió mientras lo estabas editando. Revisá su estado e intentá nuevamente.'})
        return
      }

      await Promise.all([
        client.invalidateQueries({queryKey:['superadmin-restaurants']}),
        client.invalidateQueries({queryKey:['superadmin-restaurant',id]}),
      ])
      setFeedback({kind:'success',message:`Restaurante ${next==='active'?'activado':'suspendido'} correctamente.`})
    }catch{
      setFeedback({kind:'error',message:'No se pudo actualizar el restaurante. Verificá tu conexión e intentá nuevamente.'})
    }finally{
      setPendingId(null)
    }
  }

  return <><PageHeader eyebrow="Tenants" title="Restaurantes" description="Crear, revisar, activar o suspender restaurantes. Las operaciones críticas requieren AAL2 en la base." actions={<Link className="button-primary" to="/superadmin/restaurantes/nuevo"><Plus className="h-4 w-4"/>Nuevo</Link>}/>{feedback?<p className={`mb-4 rounded-xl p-4 text-sm ${feedback.kind==='error'?'bg-red-950 text-red-200':'bg-emerald-950 text-emerald-200'}`} role={feedback.kind==='error'?'alert':'status'}>{feedback.message}</p>:null}{query.data?.length===0?<EmptyState title="Todavía no hay restaurantes" description="Creá el primero mediante la Edge Function protegida."/>:<div className="space-y-3">{query.data?.map((row)=>{const isPending=pendingId===row.id;return <article key={row.id} className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:flex-row sm:items-center"><span className="grid h-12 w-12 place-items-center rounded-xl bg-slate-800 text-orange-400"><Building2/></span><div className="min-w-0 flex-1"><Link className="font-display text-lg font-bold hover:text-orange-300" to={`/superadmin/restaurantes/${row.id}`}>{row.trade_name}</Link><p className="text-sm text-slate-400">/{row.slug} · {row.city}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${row.status==='active'?'bg-emerald-900 text-emerald-200':row.status==='suspended'?'bg-red-950 text-red-200':'bg-amber-950 text-amber-200'}`}>{row.status}</span><button aria-busy={isPending} className={row.status==='active'?'button-danger-dark':'button-secondary-dark'} disabled={pendingId!==null} onClick={()=>void status(row.id,row.status,row.status==='active'?'suspended':'active')} type="button">{isPending?'Guardando…':row.status==='active'?'Suspender':'Activar'}</button></article>})}</div>}</>}
