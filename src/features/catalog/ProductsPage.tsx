import { useQuery,useQueryClient } from '@tanstack/react-query'
import { ImageIcon,Plus,Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { ErrorPanel,EmptyState,LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { publicAssetUrl,supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'

const schema=z.object({id:z.string().uuid(),name:z.string(),code:z.string(),description:z.string(),base_price_cents:z.union([z.number(),z.string()]),promotional_price_cents:z.union([z.number(),z.string()]).nullable(),image_path:z.string().nullable(),active:z.boolean(),available:z.boolean(),featured:z.boolean(),sort_order:z.number().int(),category_id:z.string().uuid(),categories:z.object({name:z.string()}).nullable()})
type ToggleField='available'|'active'|'featured'

export function ProductsPage(){
  const scope=useRestaurantScope();const restaurant=useRestaurant(scope.selected?.id);const client=useQueryClient();const[search,setSearch]=useState('');const[mutationError,setMutationError]=useState<string|null>(null);const[busyProductId,setBusyProductId]=useState<string|null>(null)
  const query=useQuery({queryKey:['products',scope.selected?.id],enabled:Boolean(scope.selected),queryFn:async()=>{const{data,error}=await supabase.from('products').select('id,name,code,description,base_price_cents,promotional_price_cents,image_path,active,available,featured,sort_order,category_id,categories(name)').eq('restaurant_id',scope.selected?.id??'').is('deleted_at',null).order('sort_order');if(error)throw new Error('No se pudieron cargar los productos.');return z.array(schema).parse(data)}})
  if(query.isLoading||restaurant.isLoading)return <LoadingScreen/>;if(query.error||restaurant.error)return <ErrorPanel>{query.error?.message??restaurant.error?.message}</ErrorPanel>
  const normalized=search.toLowerCase().trim();const products=(query.data??[]).filter((row)=>`${row.name} ${row.code} ${row.description}`.toLowerCase().includes(normalized))

  async function toggle(id:string,field:ToggleField,value:boolean){
    const restaurantId=scope.selected?.id
    if(!restaurantId||busyProductId)return
    setBusyProductId(id);setMutationError(null)
    const update=field==='available'?{available:value}:field==='active'?{active:value}:{featured:value}
    const{error}=await supabase.from('products').update(update).eq('id',id).eq('restaurant_id',restaurantId).select('id').single()
    if(error)setMutationError('No se pudo actualizar el producto. Verificá tu acceso y volvé a intentar.')
    else await Promise.all([
      client.invalidateQueries({queryKey:['products',restaurantId]}),
      client.invalidateQueries({queryKey:['public-menu']}),
    ])
    setBusyProductId(null)
  }

  return <><PageHeader eyebrow="Catálogo" title="Productos" description="Marcá un producto como agotado sin eliminarlo. Los pedidos guardan snapshots históricos." actions={<Link className="button-primary" to="/admin/catalogo/productos/nuevo"><Plus className="h-4 w-4"/>Nuevo producto</Link>}/><label className="relative mb-5 block"><span className="sr-only">Buscar productos</span><Search className="absolute left-3 top-3 h-5 w-5 text-stone-400"/><input className="h-11 w-full rounded-2xl border border-stone-300 bg-white pl-11 pr-4" placeholder="Buscar por nombre o código" value={search} onChange={(e)=>setSearch(e.target.value)}/></label>{mutationError?<p className="form-error mb-5" role="alert">{mutationError}</p>:null}{products.length===0?<EmptyState title="No hay productos" description="Creá el primero o cambiá la búsqueda."/>:<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{products.map((row)=>{const image=publicAssetUrl(row.image_path);const busy=busyProductId===row.id;return <article className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm" key={row.id}><Link to={`/admin/catalogo/productos/${row.id}`} className="block">{image?<img src={image} alt="" className="aspect-[16/8] w-full object-cover"/>:<div className="grid aspect-[16/8] place-items-center bg-stone-100"><ImageIcon className="h-10 w-10 text-stone-300"/></div>}<div className="p-5"><p className="text-xs font-bold uppercase tracking-wide text-orange-700">{row.categories?.name??'Sin categoría'} · {row.code}</p><h2 className="mt-1 font-display text-xl font-bold">{row.name}</h2><p className="mt-3 font-bold">{formatMoney(row.promotional_price_cents??row.base_price_cents,restaurant.data?.currency_code,restaurant.data?.locale)}</p></div></Link><div className="grid grid-cols-3 border-t border-stone-200 text-xs"><button disabled={busy} className={`min-h-11 disabled:opacity-50 ${row.available?'text-emerald-700':'bg-stone-100 text-stone-500'}`} onClick={()=>void toggle(row.id,'available',!row.available)}>{row.available?'Disponible':'Agotado'}</button><button disabled={busy} className={`min-h-11 border-x border-stone-200 disabled:opacity-50 ${row.active?'text-emerald-700':'text-stone-500'}`} onClick={()=>void toggle(row.id,'active',!row.active)}>{row.active?'Activo':'Oculto'}</button><button disabled={busy} className={`min-h-11 disabled:opacity-50 ${row.featured?'text-orange-700':'text-stone-500'}`} onClick={()=>void toggle(row.id,'featured',!row.featured)}>{row.featured?'Destacado':'Destacar'}</button></div></article>})}</div>}</>
}
