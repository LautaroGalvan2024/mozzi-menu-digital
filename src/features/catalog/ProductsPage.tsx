import { keepPreviousData, useQuery,useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleCheck, CircleX, Eye, EyeOff, ImageIcon, ListOrdered, MoreHorizontal, Plus, Search, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, EmptyState } from '../../components/Feedback'
import { AdminLoading } from '../../components/AdminFeedback'
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
import { OfferOrderDialog } from './OfferOrderDialog'
import './catalog-admin.css'

const schema=z.object({id:z.string().uuid(),name:z.string(),code:z.string(),description:z.string(),base_price_cents:z.union([z.number(),z.string()]),promotional_price_cents:z.union([z.number(),z.string()]).nullable(),image_path:z.string().nullable(),active:z.boolean(),available:z.boolean(),featured:z.boolean(),sort_order:z.number().int(),category_id:z.string().uuid(),categories:z.object({name:z.string()}).nullable()})
type ToggleField='available'|'active'|'featured'
const PAGE_SIZE=50

function safeSearch(value:string){return value.trim().replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').slice(0,120)}

export function ProductsPage(){
  const location = useLocation()
  const savedCode = z.object({ savedCode: z.string() }).safeParse(location.state)
  const scope=useRestaurantScope();const restaurant=useRestaurant(scope.selected?.id);const client=useQueryClient();const[search,setSearch]=useState('');const[page,setPage]=useState(0);const[mutationError,setMutationError]=useState<string|null>(null);const[busyProductId,setBusyProductId]=useState<string|null>(null)
  const debouncedSearch=useDebouncedValue(search,300)
  const [orderEditor, setOrderEditor] = useState<string | null>(null)
  const [orderSaved, setOrderSaved] = useState<string | null>(null)
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
  if(query.isLoading||restaurant.isLoading)return <AdminLoading label="Cargando productos…" variant="list" />;if(query.error||restaurant.error)return <ErrorPanel>{query.error?.message??restaurant.error?.message}</ErrorPanel>
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
      description="Precios, disponibilidad y variantes de tu catálogo."
    />
    {savedCode.success && savedCode.data.savedCode ? <p className="form-success mb-4" role="status">Producto guardado. Código / SKU: <strong>{savedCode.data.savedCode}</strong></p> : null}
    {orderSaved && orderSaved === scope.selected?.id ? <p className="form-success mb-4" role="status">El orden de tus ofertas se guardó correctamente.</p> : null}
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
        {scope.selected && restaurant.data?.store_enabled ? <button type="button" className="button-secondary" aria-haspopup="dialog" onClick={() => {
          setOrderSaved(null)
          setOrderEditor(scope.selected?.id ?? null)
        }}><ListOrdered className="h-4 w-4" aria-hidden />Ordenar ofertas</button> : null}
        <details className="catalog-command-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
          <summary className="button-secondary list-none [&::-webkit-details-marker]:hidden">Más acciones<ChevronDown className="h-4 w-4" aria-hidden /></summary>
          <div className="catalog-command-menu-popover">
            {scope.selected ? <ProductImagesExport key={`images-${scope.selected.id}`} restaurantId={scope.selected.id} /> : null}
          </div>
        </details>
      </div>
    </div>
    {mutationError?<p className="form-error mb-5" role="alert">{mutationError}</p>:null}
    {products.length===0?<div className="admin-data-results admin-data-scroll"><EmptyState title={normalizedSearch ? 'Sin resultados' : 'Todavía no hay productos'} description={normalizedSearch ? 'Probá con otro nombre o código.' : 'Creá tu primer producto desde el botón de arriba.'}/></div>:<div className="admin-table-shell admin-data-results admin-data-scroll catalog-products-list rounded-xl border border-stone-200 bg-white">
      <div className="catalog-product-heading" aria-hidden><span>Producto</span><div><span>Estado</span><span>Precio</span></div><span /></div>
      {products.map((row)=>{
        const image=responsiveAssetUrls(row.image_path);const busy=busyProductId===row.id;const hasPromotion=row.promotional_price_cents!==null
        return <article className="catalog-product-line" key={row.id}>
          <Link to={`/admin/catalogo/productos/${row.id}`} className="catalog-product-identity flex items-center gap-3 rounded-lg focus-visible:outline-offset-4">
            {image.src?<img src={image.src} srcSet={image.srcSet} sizes="48px" alt="" loading="lazy" decoding="async" className="h-12 w-12 shrink-0 rounded-lg border border-stone-100 object-cover"/>:<span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-400"><ImageIcon className="h-5 w-5" aria-hidden/></span>}
            <div className="min-w-0">
              <h2 className="break-words text-sm font-semibold leading-5 text-stone-950">{row.name}{row.featured ? <Star className="ml-1.5 inline h-3.5 w-3.5 text-stone-400" aria-label="Destacado" /> : null}</h2>
              <p className="mt-1 break-words text-xs text-stone-600">{row.categories?.name??'Sin categoría'} <span aria-hidden>·</span> {row.code}</p>
            </div>
          </Link>
          <div className="catalog-product-details">
            <p className="catalog-product-state">
              <span className="catalog-state-badge" data-tone={!row.active ? 'neutral' : row.available ? 'success' : 'warning'}>
                {!row.active ? 'Oculto' : row.available ? 'Disponible' : 'No disponible'}
              </span>
            </p>
            <div className="catalog-product-price text-sm font-semibold tabular-nums text-stone-950">
              <p>{formatMoney(row.promotional_price_cents ?? row.base_price_cents, restaurant.data?.currency_code, restaurant.data?.locale)}</p>
              {hasPromotion ? <p className="mt-0.5 text-xs font-normal text-stone-500 line-through">{formatMoney(row.base_price_cents, restaurant.data?.currency_code, restaurant.data?.locale)}</p> : null}
            </div>
          </div>
          <div className="catalog-product-control flex items-center justify-end gap-1">
            <Link className="hidden rounded-lg px-2 py-2 text-sm font-medium text-stone-600 hover:text-stone-950 sm:block" aria-label={`Editar ${row.name}`} to={`/admin/catalogo/productos/${row.id}`}>Editar</Link>
            <details className="catalog-product-actions relative" name="product-actions" onToggle={event => { const details=event.currentTarget; if(!details.open){delete details.dataset.placement;return} const menu=details.querySelector<HTMLElement>('.catalog-product-actions-menu');const viewport=details.closest<HTMLElement>('.catalog-products-list');if(!menu||!viewport)return;const trigger=details.getBoundingClientRect();const bounds=viewport.getBoundingClientRect();const below=bounds.bottom-trigger.bottom;const above=trigger.top-bounds.top;details.dataset.placement=below<menu.offsetHeight&&above>below?'top':'bottom' }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
              <summary className="icon-button list-none [&::-webkit-details-marker]:hidden" aria-label={`Opciones de ${row.name}`}><MoreHorizontal className="h-5 w-5" aria-hidden /></summary>
              <div className="catalog-product-actions-menu absolute right-0 z-20 grid w-60 gap-1 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg">
                <Link className="rounded-lg px-3 py-2.5 text-sm hover:bg-stone-50" to={`/admin/catalogo/productos/${row.id}`}>Editar producto</Link>
                <button type="button" disabled={Boolean(busyProductId)} aria-pressed={row.available} aria-label={`${row.available?'Disponible':'No disponible'}: ${row.name}`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50" onClick={()=>void toggle(row.id,'available',!row.available)}>{row.available?<CircleX className="h-4 w-4" aria-hidden/>:<CircleCheck className="h-4 w-4" aria-hidden/>}{row.available?'Marcar no disponible':'Marcar disponible'}</button>
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
    {orderEditor && orderEditor === scope.selected?.id && restaurant.data?.store_enabled ? <OfferOrderDialog key={orderEditor}
      restaurantId={orderEditor} currency={restaurant.data.currency_code} locale={restaurant.data.locale}
      onClose={() => setOrderEditor(null)}
      onSaved={() => {
        setOrderSaved(orderEditor)
        setOrderEditor(null)
        void invalidateCatalogQueries(client, orderEditor)
      }} /> : null}
  </AdminDataWorkspace>
}
