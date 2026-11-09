import { keepPreviousData, useQuery,useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleCheck, CircleX, Eye, EyeOff, ImageIcon, MoreHorizontal, Plus, Search, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { z } from 'zod'
import { ErrorPanel,EmptyState,LoadingScreen } from '../../components/Feedback'
import { AdminDataRegion, AdminDataWorkspace } from '../../components/AdminDataWorkspace'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { queryKeys } from '../../lib/queryKeys'
import { supabase } from '../../lib/supabase/client'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { ProductFamilies } from './ProductFamilies'
import { ProductImagesExport } from './ProductImagesExport'

const schema=z.object({id:z.string().uuid(),name:z.string(),code:z.string(),description:z.string(),base_price_cents:z.union([z.number(),z.string()]),promotional_price_cents:z.union([z.number(),z.string()]).nullable(),image_path:z.string().nullable(),active:z.boolean(),available:z.boolean(),featured:z.boolean(),sort_order:z.number().int(),category_id:z.string().uuid(),categories:z.object({name:z.string()}).nullable()})
type ToggleField='available'|'active'|'featured'
const PAGE_SIZE=50

function safeSearch(value:string){return value.trim().replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').slice(0,120)}

export function ProductsPage(){
  const location = useLocation()
  const savedCode = z.object({ savedCode: z.string() }).safeParse(location.state)
  const scope=useRestaurantScope();const restaurant=useRestaurant(scope.selected?.id);const client=useQueryClient();const[search,setSearch]=useState('');const[page,setPage]=useState(0);const[mutationError,setMutationError]=useState<string|null>(null);const[busyProductId,setBusyProductId]=useState<string|null>(null)
  const debouncedSearch=useDebouncedValue(search,300)
  const normalizedSearch=safeSearch(debouncedSearch)
  useEffect(()=>setPage(0),[normalizedSearch,scope.selected?.id])
  const query=useQuery({
    queryKey:[...queryKeys.products(scope.selected?.id),page,normalizedSearch],
    enabled:Boolean(scope.selected),
    placeholderData:keepPreviousData,
    queryFn:async({signal})=>{
      let request=supabase.from('products').select('id,name,code,description,base_price_cents,promotional_price_cents,image_path,active,available,featured,sort_order,category_id,categories(name)',{count:'exact'}).eq('restaurant_id',scope.selected?.id??'').is('deleted_at',null).order('sort_order').order('id').range(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE-1).abortSignal(signal)
      if(normalizedSearch)request=request.or(`name.ilike.%${normalizedSearch}%,code.ilike.%${normalizedSearch}%,description.ilike.%${normalizedSearch}%`)
      const{data,error,count}=await request
      if(error)throw new Error('No se pudieron cargar los productos.')
      const rows=z.array(schema).parse(data)
      return{rows,count:count??rows.length}
    },
  })
  if(query.isLoading||restaurant.isLoading)return <LoadingScreen/>;if(query.error||restaurant.error)return <ErrorPanel>{query.error?.message??restaurant.error?.message}</ErrorPanel>
  const products=query.data?.rows??[];const total=query.data?.count??0

  async function toggle(id:string,field:ToggleField,value:boolean){
    const restaurantId=scope.selected?.id
    if(!restaurantId||busyProductId)return
    setBusyProductId(id);setMutationError(null)
    const update=field==='available'?{available:value}:field==='active'?{active:value}:{featured:value}
    const{error}=await supabase.from('products').update(update).eq('id',id).eq('restaurant_id',restaurantId).select('id').single()
    if(error)setMutationError('No se pudo actualizar el producto. Verificá tu acceso y volvé a intentar.')
    else await invalidateCatalogQueries(client,restaurantId)
    setBusyProductId(null)
  }

  return <AdminDataWorkspace className="catalog-data-workspace">
    <PageHeader
      eyebrow="Catálogo"
      title="Productos"
      description="Administrá los productos, precios y disponibilidad de tu catálogo."
    />
    {savedCode.success && savedCode.data.savedCode ? <p className="form-success mb-4" role="status">Producto guardado. Código / SKU: <strong>{savedCode.data.savedCode}</strong></p> : null}
    <AdminDataRegion className="catalog-data-region">
    <div className="admin-toolbar catalog-command-bar">
      <label className="catalog-command-search relative block">
        <span className="sr-only">Buscar productos</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-stone-400" aria-hidden/>
        <input className="h-11 w-full rounded-xl border border-stone-300 bg-white pl-10 pr-4 text-sm outline-none transition duration-150 placeholder:text-stone-400 hover:border-stone-400 focus:border-orange-500 focus:ring-3 focus:ring-orange-100" placeholder="Buscar por nombre o código" value={search} onChange={(e)=>setSearch(e.target.value)}/>
      </label>
      <p className="catalog-command-count" role="status">{total} {total === 1 ? 'producto' : 'productos'}{query.isFetching?' · Actualizando…':''}</p>
      <div className="catalog-command-actions">
        <Link className="button-primary" to="/admin/catalogo/productos/nuevo"><Plus className="h-4 w-4" aria-hidden/>Nuevo producto</Link>
        <ProductFamilies key={scope.selected?.id} />
        <details className="catalog-command-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
          <summary className="button-secondary list-none [&::-webkit-details-marker]:hidden">Más acciones<ChevronDown className="h-4 w-4" aria-hidden /></summary>
          <div className="catalog-command-menu-popover">
            {scope.selected ? <ProductImagesExport key={`images-${scope.selected.id}`} restaurantId={scope.selected.id} /> : null}
          </div>
        </details>
      </div>
    </div>
    {mutationError?<p className="form-error mb-5" role="alert">{mutationError}</p>:null}
    {products.length===0?<div className="admin-data-results admin-data-scroll"><EmptyState title="No hay productos" description="Creá el primero o cambiá la búsqueda."/></div>:<div className="admin-table-shell admin-data-results admin-data-scroll catalog-products-list rounded-xl border border-stone-200 bg-white">
      <div className="catalog-products-header hidden grid-cols-[minmax(0,1fr)_8rem_8rem_6rem] gap-4 border-b border-stone-200 px-5 py-3 text-xs font-medium text-stone-500 lg:grid" aria-hidden><span>Producto</span><span>Estado</span><span className="text-right">Precio</span><span /></div>
      {products.map((row)=>{
        const image=responsiveAssetUrls(row.image_path);const busy=busyProductId===row.id;const hasPromotion=row.promotional_price_cents!==null
        return <article className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 border-b border-stone-100 p-4 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_8rem_8rem_6rem] lg:px-5" key={row.id}>
          <Link to={`/admin/catalogo/productos/${row.id}`} className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline-offset-4">
            {image.src?<img src={image.src} srcSet={image.srcSet} sizes="48px" alt="" loading="lazy" decoding="async" className="h-12 w-12 shrink-0 rounded-lg border border-stone-100 object-cover"/>:<span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-400"><ImageIcon className="h-5 w-5" aria-hidden/></span>}
            <div className="min-w-0">
              <h2 className="break-words text-sm font-semibold leading-5 text-stone-950">{row.name}{row.featured ? <Star className="ml-1.5 inline h-3.5 w-3.5 text-stone-400" aria-label="Destacado" /> : null}</h2>
              <p className="mt-1 truncate text-xs text-stone-500">{row.categories?.name??'Sin categoría'} <span aria-hidden>·</span> {row.code}</p>
            </div>
          </Link>
          <p className="col-start-1 row-start-2 flex items-center gap-1.5 pl-15 text-xs text-stone-600 lg:col-auto lg:row-auto lg:pl-0"><span className={`h-1.5 w-1.5 rounded-full ${!row.active?'bg-stone-300':row.available?'bg-emerald-600':'bg-amber-600'}`} aria-hidden />{!row.active?'Oculto':row.available?'Disponible':'Agotado'}</p>
          <div className="col-start-1 row-start-3 pl-15 text-sm font-semibold tabular-nums text-stone-950 sm:col-start-2 sm:row-start-2 sm:pl-0 sm:text-right lg:col-auto lg:row-auto">
            <p>{formatMoney(row.promotional_price_cents??row.base_price_cents,restaurant.data?.currency_code,restaurant.data?.locale)}</p>
            {hasPromotion?<p className="mt-0.5 text-xs font-normal text-stone-400 line-through">{formatMoney(row.base_price_cents,restaurant.data?.currency_code,restaurant.data?.locale)}</p>:null}
          </div>
          <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 lg:col-auto lg:row-auto">
            <Link className="hidden rounded-lg px-2 py-2 text-sm font-medium text-stone-600 hover:text-stone-950 sm:block" aria-label={`Editar ${row.name}`} to={`/admin/catalogo/productos/${row.id}`}>Editar</Link>
            <details className="catalog-product-actions relative" name="product-actions" onToggle={event => { const details=event.currentTarget; if(!details.open){delete details.dataset.placement;return} const menu=details.querySelector<HTMLElement>('.catalog-product-actions-menu');const viewport=details.closest<HTMLElement>('.catalog-products-list');if(!menu||!viewport)return;const trigger=details.getBoundingClientRect();const bounds=viewport.getBoundingClientRect();const below=bounds.bottom-trigger.bottom;const above=trigger.top-bounds.top;details.dataset.placement=below<menu.offsetHeight&&above>below?'top':'bottom' }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
              <summary className="icon-button list-none [&::-webkit-details-marker]:hidden" aria-label={`Opciones de ${row.name}`}><MoreHorizontal className="h-5 w-5" aria-hidden /></summary>
              <div className="catalog-product-actions-menu absolute right-0 z-20 grid w-60 gap-1 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg">
                <Link className="rounded-lg px-3 py-2.5 text-sm hover:bg-stone-50" to={`/admin/catalogo/productos/${row.id}`}>Editar producto</Link>
                <button type="button" disabled={Boolean(busyProductId)} aria-pressed={row.available} aria-label={`${row.available?'Disponible':'Agotado'}: ${row.name}`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50" onClick={()=>void toggle(row.id,'available',!row.available)}>{row.available?<CircleX className="h-4 w-4" aria-hidden/>:<CircleCheck className="h-4 w-4" aria-hidden/>}{row.available?'Marcar agotado':'Marcar disponible'}</button>
                <button type="button" disabled={Boolean(busyProductId)} aria-pressed={row.active} aria-label={`${row.active?'Activo':'Oculto'}: ${row.name}`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50" onClick={()=>void toggle(row.id,'active',!row.active)}>{row.active?<EyeOff className="h-4 w-4" aria-hidden/>:<Eye className="h-4 w-4" aria-hidden/>}{row.active?'Ocultar producto':'Mostrar producto'}</button>
                <button type="button" disabled={Boolean(busyProductId)} aria-pressed={row.featured} aria-label={`${row.featured?'Destacado':'Sin destacar'}: ${row.name}`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50" onClick={()=>void toggle(row.id,'featured',!row.featured)}><Star className="h-4 w-4" aria-hidden/>{row.featured?'Quitar destacado':'Destacar producto'}</button>
                {busy ? <p role="status" className="px-3 py-2 text-xs text-stone-500">Guardando…</p> : null}
              </div>
            </details>
          </div>
        </article>
      })}
    </div>}
    {total>PAGE_SIZE?<nav className="admin-data-pagination" aria-label="Páginas de productos"><p className="text-sm text-stone-500">Página {page+1} de {Math.max(1,Math.ceil(total/PAGE_SIZE))}</p><div className="flex gap-2"><button className="button-secondary" type="button" disabled={page===0||query.isFetching} onClick={()=>setPage(value=>Math.max(0,value-1))}>Anterior</button><button className="button-secondary" type="button" disabled={(page+1)*PAGE_SIZE>=total||query.isFetching} onClick={()=>setPage(value=>value+1)}>Siguiente</button></div></nav>:null}
    </AdminDataRegion>
  </AdminDataWorkspace>
}
