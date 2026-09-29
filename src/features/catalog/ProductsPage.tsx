import { useQuery,useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, Eye, EyeOff, ImageIcon, Plus, Search, Star } from 'lucide-react'
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

  return <>
    <PageHeader
      eyebrow="Catálogo"
      title="Productos"
      description="Marcá un producto como agotado sin eliminarlo. Los pedidos guardan snapshots históricos."
      actions={<Link className="button-primary w-full sm:w-auto" to="/admin/catalogo/productos/nuevo"><Plus className="h-4 w-4" aria-hidden/>Nuevo producto</Link>}
    />
    <div className="filter-bar mb-5 p-3">
      <label className="relative block">
        <span className="sr-only">Buscar productos</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-stone-400" aria-hidden/>
        <input className="h-11 w-full rounded-xl border border-stone-300 bg-white pl-10 pr-4 text-sm outline-none transition duration-150 placeholder:text-stone-400 hover:border-stone-400 focus:border-orange-500 focus:ring-3 focus:ring-orange-100" placeholder="Buscar por nombre o código" value={search} onChange={(e)=>setSearch(e.target.value)}/>
      </label>
    </div>
    {mutationError?<p className="form-error mb-5" role="alert">{mutationError}</p>:null}
    {products.length===0?<EmptyState title="No hay productos" description="Creá el primero o cambiá la búsqueda."/>:<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {products.map((row)=>{
        const image=publicAssetUrl(row.image_path);const busy=busyProductId===row.id;const hasPromotion=row.promotional_price_cents!==null
        return <article className="surface-card group flex min-w-0 flex-col overflow-hidden transition duration-150 hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md focus-within:border-orange-300" key={row.id}>
          <Link to={`/admin/catalogo/productos/${row.id}`} className="flex flex-1 flex-col">
            <div className="overflow-hidden bg-stone-100">
              {image?<img src={image} alt="" className="aspect-[16/10] w-full object-cover transition duration-150 group-hover:scale-[1.015]"/>:<div className="grid aspect-[16/10] place-items-center bg-stone-100"><span className="grid h-14 w-14 place-items-center rounded-2xl border border-stone-200 bg-white text-stone-300 shadow-sm"><ImageIcon className="h-6 w-6" aria-hidden/></span></div>}
            </div>
            <div className="flex flex-1 flex-col p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="status-badge border-orange-200 bg-orange-50 text-orange-800">{row.categories?.name??'Sin categoría'}</span>
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[.08em] text-stone-500">{row.code}</span>
              </div>
              <h2 className="mt-3 font-display text-xl font-bold leading-tight tracking-tight text-stone-950">{row.name}</h2>
              <div className="mt-auto flex items-end justify-between gap-3 pt-5">
                <div>
                  <p className="font-display text-xl font-bold tracking-tight text-stone-950">{formatMoney(row.promotional_price_cents??row.base_price_cents,restaurant.data?.currency_code,restaurant.data?.locale)}</p>
                  {hasPromotion?<p className="mt-0.5 text-xs font-medium text-stone-400 line-through">{formatMoney(row.base_price_cents,restaurant.data?.currency_code,restaurant.data?.locale)}</p>:null}
                </div>
                <span className="text-xs font-semibold text-stone-500 transition group-hover:text-orange-700">Editar</span>
              </div>
            </div>
          </Link>
          <div className="grid grid-cols-3 divide-x divide-stone-200 border-t border-stone-200 text-xs">
            <button type="button" disabled={busy} aria-pressed={row.available} aria-label={`${row.available?'Disponible':'Agotado'}: ${row.name}`} className={`flex min-h-12 items-center justify-center gap-1.5 px-2 text-[11px] font-bold transition duration-150 focus-visible:z-10 disabled:cursor-wait disabled:opacity-50 sm:text-xs ${row.available?'bg-emerald-50/70 text-emerald-800 hover:bg-emerald-100':'bg-stone-50 text-stone-600 hover:bg-stone-100'}`} onClick={()=>void toggle(row.id,'available',!row.available)}>{row.available?<CircleCheck className="h-4 w-4 shrink-0" aria-hidden/>:<CircleX className="h-4 w-4 shrink-0" aria-hidden/>}{row.available?'Disponible':'Agotado'}</button>
            <button type="button" disabled={busy} aria-pressed={row.active} aria-label={`${row.active?'Activo':'Oculto'}: ${row.name}`} className={`flex min-h-12 items-center justify-center gap-1.5 px-2 text-[11px] font-bold transition duration-150 focus-visible:z-10 disabled:cursor-wait disabled:opacity-50 sm:text-xs ${row.active?'bg-sky-50/70 text-sky-800 hover:bg-sky-100':'bg-stone-50 text-stone-600 hover:bg-stone-100'}`} onClick={()=>void toggle(row.id,'active',!row.active)}>{row.active?<Eye className="h-4 w-4 shrink-0" aria-hidden/>:<EyeOff className="h-4 w-4 shrink-0" aria-hidden/>}{row.active?'Activo':'Oculto'}</button>
            <button type="button" disabled={busy} aria-pressed={row.featured} aria-label={`${row.featured?'Destacado':'Sin destacar'}: ${row.name}`} className={`flex min-h-12 items-center justify-center gap-1.5 px-2 text-[11px] font-bold transition duration-150 focus-visible:z-10 disabled:cursor-wait disabled:opacity-50 sm:text-xs ${row.featured?'bg-amber-50/80 text-amber-800 hover:bg-amber-100':'bg-stone-50 text-stone-600 hover:bg-stone-100'}`} onClick={()=>void toggle(row.id,'featured',!row.featured)}><Star className={`h-4 w-4 shrink-0 ${row.featured?'fill-current':''}`} aria-hidden/>{row.featured?'Destacado':'Destacar'}</button>
          </div>
        </article>
      })}
    </div>}
  </>
}
