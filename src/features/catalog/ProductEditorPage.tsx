import { useQuery,useQueryClient } from '@tanstack/react-query'
import { ArrowLeft,ImagePlus,Plus,Save,Trash2 } from 'lucide-react'
import { useEffect,useMemo,useState,type ChangeEvent } from 'react'
import { Link,Navigate,useNavigate,useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel,LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { processImage } from '../../lib/images/processImage'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { publicAssetUrl,supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'

interface OptionDraft{id:string;name:string;price:string;sortOrder:number;active:boolean}
interface GroupDraft{id:string;name:string;required:boolean;minSelect:number;maxSelect:number;sortOrder:number;active:boolean;options:OptionDraft[]}
interface ProductDraft{id:string;categoryId:string;code:string;name:string;description:string;basePrice:string;promotionalPrice:string;promotionStartsAt:string;promotionEndsAt:string;imagePath:string|null;active:boolean;available:boolean;featured:boolean;sortOrder:number;groups:GroupDraft[]}
const categorySchema=z.array(z.object({id:z.string().uuid(),name:z.string()}))
const productSchema=z.object({id:z.string().uuid(),category_id:z.string().uuid(),code:z.string(),name:z.string(),description:z.string(),base_price_cents:z.union([z.number(),z.string()]),promotional_price_cents:z.union([z.number(),z.string()]).nullable(),promotion_starts_at:z.string().nullable(),promotion_ends_at:z.string().nullable(),image_path:z.string().nullable(),active:z.boolean(),available:z.boolean(),featured:z.boolean(),sort_order:z.number().int()})
const groupSchema=z.array(z.object({id:z.string().uuid(),name:z.string(),required:z.boolean(),min_select:z.number().int(),max_select:z.number().int(),sort_order:z.number().int(),active:z.boolean()}))
const optionSchema=z.array(z.object({id:z.string().uuid(),option_group_id:z.string().uuid(),name:z.string(),price_delta_cents:z.union([z.number(),z.string()]),sort_order:z.number().int(),active:z.boolean()}))
function toLocal(value:string|null){if(!value)return'';const date=new Date(value);const offset=date.getTimezoneOffset();return new Date(date.getTime()-offset*60000).toISOString().slice(0,16)}
export function ProductEditorPage(){const{productId}=useParams();const isNew=productId===undefined||productId==='nuevo';const validId=isNew||z.string().uuid().safeParse(productId).success;const scope=useRestaurantScope();const client=useQueryClient();const navigate=useNavigate();const[draft,setDraft]=useState<ProductDraft|null>(null);const[imageFile,setImageFile]=useState<File|null>(null);const[saving,setSaving]=useState(false);const[error,setError]=useState<string|null>(null)
const categories=useQuery({queryKey:['categories-options',scope.selected?.id],enabled:Boolean(scope.selected),queryFn:async()=>{const{data,error:loadError}=await supabase.from('categories').select('id,name').eq('restaurant_id',scope.selected?.id??'').is('deleted_at',null).eq('active',true).order('sort_order');if(loadError)throw new Error('No se pudieron cargar las categorías.');return categorySchema.parse(data)}})
const product=useQuery({queryKey:['product-editor',scope.selected?.id,productId],enabled:Boolean(scope.selected&&!isNew&&validId),queryFn:async()=>{
  const[p,g]=await Promise.all([
    supabase.from('products').select('*').eq('id',productId??'').eq('restaurant_id',scope.selected?.id??'').single(),
    supabase.from('product_option_groups').select('*').eq('product_id',productId??'').eq('restaurant_id',scope.selected?.id??'').eq('active',true).order('sort_order'),
  ])
  if(p.error||g.error)throw new Error('No se pudo cargar el producto.')
  const parsedProduct=productSchema.parse(p.data),groups=groupSchema.parse(g.data)
  if(groups.length===0)return{product:parsedProduct,groups,options:[]}
  const o=await supabase.from('product_options').select('*').eq('restaurant_id',scope.selected?.id??'').in('option_group_id',groups.map((group)=>group.id)).eq('active',true).order('sort_order')
  if(o.error)throw new Error('No se pudo cargar el producto.')
  return{product:parsedProduct,groups,options:optionSchema.parse(o.data)}
}})
useEffect(()=>{setDraft(null);setImageFile(null);setError(null)},[productId,scope.selected?.id])
useEffect(()=>{if(draft||!scope.selected)return;if(isNew&&categories.data?.[0]){setDraft({id:crypto.randomUUID(),categoryId:categories.data[0].id,code:'',name:'',description:'',basePrice:'0',promotionalPrice:'',promotionStartsAt:'',promotionEndsAt:'',imagePath:null,active:true,available:true,featured:false,sortOrder:0,groups:[]})}else if(product.data){const p=product.data.product;setDraft({id:p.id,categoryId:p.category_id,code:p.code,name:p.name,description:p.description,basePrice:(Number(p.base_price_cents)/100).toString(),promotionalPrice:p.promotional_price_cents===null?'':(Number(p.promotional_price_cents)/100).toString(),promotionStartsAt:toLocal(p.promotion_starts_at),promotionEndsAt:toLocal(p.promotion_ends_at),imagePath:p.image_path,active:p.active,available:p.available,featured:p.featured,sortOrder:p.sort_order,groups:product.data.groups.map((g)=>({id:g.id,name:g.name,required:g.required,minSelect:g.min_select,maxSelect:g.max_select,sortOrder:g.sort_order,active:g.active,options:product.data!.options.filter((o)=>o.option_group_id===g.id).map((o)=>({id:o.id,name:o.name,price:(Number(o.price_delta_cents)/100).toString(),sortOrder:o.sort_order,active:o.active}))}))})}},[categories.data,draft,isNew,product.data,scope.selected])
const originalGroupIds=useMemo(()=>new Set(product.data?.groups.map((g)=>g.id)??[]),[product.data]);const originalOptionIds=useMemo(()=>new Set(product.data?.options.map((o)=>o.id)??[]),[product.data])
const imagePreview=useMemo(()=>imageFile?URL.createObjectURL(imageFile):publicAssetUrl(draft?.imagePath??null),[draft?.imagePath,imageFile])
useEffect(()=>()=>{if(imagePreview?.startsWith('blob:'))URL.revokeObjectURL(imagePreview)},[imagePreview])
 if(!validId)return <Navigate to="/admin/catalogo/productos" replace/>;if(categories.isLoading||(!isNew&&product.isLoading))return <LoadingScreen/>;if(categories.error||product.error)return <ErrorPanel>{categories.error?.message??product.error?.message}</ErrorPanel>;if(!categories.data?.length)return <ErrorPanel title="Primero creá una categoría">Necesitás al menos una categoría activa antes de crear productos.<div className="mt-4"><Link className="button-primary" to="/admin/catalogo/categorias">Crear categoría</Link></div></ErrorPanel>;if(!draft)return <LoadingScreen/>
function patch<K extends keyof ProductDraft>(key:K,value:ProductDraft[K]){setDraft((d)=>d?{...d,[key]:value}:d)}function patchGroup(id:string,values:Partial<GroupDraft>){patch('groups',draft!.groups.map((g)=>g.id===id?{...g,...values}:g))}function patchOption(groupId:string,id:string,values:Partial<OptionDraft>){patch('groups',draft!.groups.map((g)=>g.id===groupId?{...g,options:g.options.map((o)=>o.id===id?{...o,...values}:o)}:g))}function addGroup(){patch('groups',[...draft!.groups,{id:crypto.randomUUID(),name:'',required:false,minSelect:0,maxSelect:1,sortOrder:draft!.groups.length,active:true,options:[]}])}function removeGroup(id:string){patch('groups',draft!.groups.filter((g)=>g.id!==id))}function addOption(groupId:string){patch('groups',draft!.groups.map((g)=>g.id===groupId?{...g,options:[...g.options,{id:crypto.randomUUID(),name:'',price:'0',sortOrder:g.options.length,active:true}]}:g))}
async function save(){
  if(!scope.selected)return
  const restaurantId=scope.selected.id
  const currentDraft=draft!
  const maxCents=1_000_000_000_000
  const base=Math.round(Number(currentDraft.basePrice.replace(',','.'))*100)
  const promo=currentDraft.promotionalPrice.trim()===''?null:Math.round(Number(currentDraft.promotionalPrice.replace(',','.'))*100)
  const startsAt=currentDraft.promotionStartsAt?new Date(currentDraft.promotionStartsAt):null
  const endsAt=currentDraft.promotionEndsAt?new Date(currentDraft.promotionEndsAt):null
  const moneyIsValid=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=maxCents
  setSaving(true);setError(null)
  if(!currentDraft.name.trim()||currentDraft.name.trim().length>160||!currentDraft.code.trim()||currentDraft.code.trim().length>80||currentDraft.description.length>2000||!moneyIsValid(base)||(promo!==null&&(!moneyIsValid(promo)||promo>base))||!Number.isInteger(currentDraft.sortOrder)||Math.abs(currentDraft.sortOrder)>100000||(startsAt!==null&&Number.isNaN(startsAt.getTime()))||(endsAt!==null&&Number.isNaN(endsAt.getTime()))||(startsAt&&endsAt&&endsAt<=startsAt)){
    setError('Completá nombre, código, precios y vigencia con valores válidos.');setSaving(false);return
  }
  const groups=currentDraft.groups.map((group)=>({...group,options:group.options.map((option)=>({...option,priceDeltaCents:Math.round(Number(option.price.replace(',','.'))*100)}))}))
  for(const group of groups){
    const activeOptionCount=group.options.filter((option)=>option.active).length
    if(!group.name.trim()||group.name.trim().length>120||!Number.isInteger(group.minSelect)||!Number.isInteger(group.maxSelect)||group.minSelect<0||group.minSelect>activeOptionCount||group.maxSelect<group.minSelect||group.maxSelect>20||(group.required&&group.minSelect<1)||!Number.isInteger(group.sortOrder)||Math.abs(group.sortOrder)>100000||group.options.some((option)=>!option.name.trim()||option.name.trim().length>120||!moneyIsValid(option.priceDeltaCents)||!Number.isInteger(option.sortOrder)||Math.abs(option.sortOrder)>100000)){
      setError('Revisá nombres, precios y límites de los grupos de opciones.');setSaving(false);return
    }
  }
  const currentGroupIds=new Set(currentDraft.groups.map((group)=>group.id))
  const currentOptionIds=new Set(currentDraft.groups.flatMap((group)=>group.options.map((option)=>option.id)))
  const removedGroups=[...originalGroupIds].filter((id)=>!currentGroupIds.has(id))
  const removedOptions=[...originalOptionIds].filter((id)=>!currentOptionIds.has(id))
  const previousPath=product.data?.product.image_path??null
  let nextPath=currentDraft.imagePath
  let uploadedPath:string|null=null
  let cleanupPending=false
  let imageStateUncertain=false
  const cleanupAsset=async(path:string)=>{
    const[storageResult,assetResult]=await Promise.all([
      supabase.storage.from('restaurant-assets').remove([path]),
      supabase.from('image_assets').update({deleted_at:new Date().toISOString()}).eq('restaurant_id',restaurantId).eq('path',path),
    ])
    return !storageResult.error&&!assetResult.error
  }
  try{
    if(imageFile){
      const processed=await processImage(imageFile)
      uploadedPath=await uploadRestaurantImage({restaurantId,kind:'products',entityId:currentDraft.id,image:processed})
      nextPath=uploadedPath
    }
    const{error:saveError}=await supabase.rpc('save_product_catalog',{
      p_restaurant_id:restaurantId,
      p_product:{id:currentDraft.id,categoryId:currentDraft.categoryId,code:currentDraft.code.trim(),name:currentDraft.name.trim(),description:currentDraft.description.trim(),basePriceCents:base,promotionalPriceCents:promo,promotionStartsAt:startsAt?.toISOString()??null,promotionEndsAt:endsAt?.toISOString()??null,imagePath:nextPath,active:currentDraft.active,available:currentDraft.available,featured:currentDraft.featured,sortOrder:currentDraft.sortOrder},
      p_groups:groups.map((group)=>({id:group.id,name:group.name.trim(),required:group.required,minSelect:group.minSelect,maxSelect:group.maxSelect,sortOrder:group.sortOrder,active:group.active,options:group.options.map((option)=>({id:option.id,name:option.name.trim(),priceDeltaCents:option.priceDeltaCents,sortOrder:option.sortOrder,active:option.active}))})),
      p_removed_group_ids:removedGroups,
      p_removed_option_ids:removedOptions,
    })
    if(saveError){
      if(uploadedPath){
        const verification=await supabase.from('products').select('image_path').eq('id',currentDraft.id).eq('restaurant_id',restaurantId).maybeSingle()
        if(verification.error)imageStateUncertain=true
        else if(verification.data?.image_path!==uploadedPath)cleanupPending=!(await cleanupAsset(uploadedPath))
      }
      throw saveError
    }
    await Promise.all([client.invalidateQueries({queryKey:['products',restaurantId]}),client.invalidateQueries({queryKey:['public-menu']})])
    if(previousPath&&previousPath!==nextPath){
      const cleaned=await cleanupAsset(previousPath)
      if(!cleaned){
        setDraft((value)=>value?{...value,imagePath:nextPath}:value);setImageFile(null)
        setError('El producto quedó guardado, pero no se pudo retirar la imagen anterior. Reintentá la limpieza desde esta pantalla.')
        return
      }
    }
    navigate('/admin/catalogo/productos')
  }catch{
    setError(imageStateUncertain?'No se pudo confirmar el resultado del guardado. Recargá el producto antes de reintentar para no duplicar imágenes.':cleanupPending?'No se pudo guardar el producto y la imagen nueva quedó pendiente de limpieza. Revisá Storage antes de reintentar.':'No se pudo guardar el producto completo. Revisá que el código no esté repetido y reintentá.')
  }finally{setSaving(false)}
}
async function archive(){if(!scope.selected||!window.confirm('¿Ocultar este producto? El historial de pedidos no se elimina.'))return;setError(null);const{error:archiveError}=await supabase.from('products').update({deleted_at:new Date().toISOString(),active:false}).eq('id',draft!.id).eq('restaurant_id',scope.selected.id);if(archiveError){setError('No se pudo dar de baja el producto.');return}navigate('/admin/catalogo/productos')}
return <><PageHeader eyebrow="Catálogo" title={isNew?'Nuevo producto':`Editar ${draft.name}`} description="Los precios se guardan en centavos y se validan nuevamente al crear el pedido." actions={<Link className="button-secondary" to="/admin/catalogo/productos"><ArrowLeft className="h-4 w-4"/>Volver</Link>}/><div className="space-y-6"><section className="form-card"><h2 className="form-card-title">Datos principales</h2><div className="grid gap-4 sm:grid-cols-2"><label className="field"><span>Nombre</span><input maxLength={160} value={draft.name} onChange={(e)=>patch('name',e.target.value)}/></label><label className="field"><span>Código único</span><input maxLength={80} value={draft.code} onChange={(e)=>patch('code',e.target.value)}/></label><label className="field"><span>Categoría</span><select value={draft.categoryId} onChange={(e)=>patch('categoryId',e.target.value)}>{categories.data.map((category)=><option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label className="field"><span>Orden</span><input type="number" min="0" value={draft.sortOrder} onChange={(e)=>patch('sortOrder',Number(e.target.value))}/></label><label className="field sm:col-span-2"><span>Descripción</span><textarea rows={3} maxLength={2000} value={draft.description} onChange={(e)=>patch('description',e.target.value)}/></label><label className="field"><span>Precio base</span><input type="number" min="0" step="0.01" value={draft.basePrice} onChange={(e)=>patch('basePrice',e.target.value)}/></label><label className="field"><span>Precio promocional</span><input type="number" min="0" step="0.01" value={draft.promotionalPrice} onChange={(e)=>patch('promotionalPrice',e.target.value)} placeholder="Sin promoción"/></label><label className="field"><span>Promoción desde</span><input type="datetime-local" value={draft.promotionStartsAt} onChange={(e)=>patch('promotionStartsAt',e.target.value)}/></label><label className="field"><span>Promoción hasta</span><input type="datetime-local" value={draft.promotionEndsAt} onChange={(e)=>patch('promotionEndsAt',e.target.value)}/></label></div><div className="mt-5 flex flex-wrap gap-4"><label className="check-field"><input type="checkbox" checked={draft.active} onChange={(e)=>patch('active',e.target.checked)}/>Activo</label><label className="check-field"><input type="checkbox" checked={draft.available} onChange={(e)=>patch('available',e.target.checked)}/>Disponible</label><label className="check-field"><input type="checkbox" checked={draft.featured} onChange={(e)=>patch('featured',e.target.checked)}/>Destacado</label></div></section><section className="form-card"><h2 className="form-card-title">Foto</h2><div className="flex flex-col gap-5 sm:flex-row sm:items-center">{imagePreview?<img className="h-36 w-48 rounded-2xl object-cover" src={imagePreview} alt="Previsualización del producto"/>:<div className="grid h-36 w-48 place-items-center rounded-2xl bg-stone-100"><ImagePlus className="h-10 w-10 text-stone-300"/></div>}<div className="flex flex-wrap gap-2"><label className="button-secondary cursor-pointer"><ImagePlus className="h-4 w-4"/>Elegir o tomar foto<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e:ChangeEvent<HTMLInputElement>)=>setImageFile(e.target.files?.[0]??null)}/></label>{imagePreview?<button className="button-danger" type="button" onClick={()=>{setImageFile(null);patch('imagePath',null)}}><Trash2 className="h-4 w-4"/>Quitar imagen</button>:null}</div></div></section><section className="form-card"><div className="flex justify-between"><div><h2 className="form-card-title">Variantes y adicionales</h2><p className="text-sm text-stone-500">Definí mínimos y máximos por grupo.</p></div><button className="button-secondary" onClick={addGroup}><Plus className="h-4 w-4"/>Grupo</button></div><div className="mt-5 space-y-5">{draft.groups.map((group)=><article key={group.id} className="rounded-2xl border border-stone-200 p-4"><div className="grid items-end gap-3 md:grid-cols-[1fr_100px_100px_auto_auto]"><label className="field"><span>Nombre del grupo</span><input maxLength={120} value={group.name} onChange={(e)=>patchGroup(group.id,{name:e.target.value})}/></label><label className="field"><span>Mínimo</span><input type="number" min="0" max="20" value={group.minSelect} onChange={(e)=>patchGroup(group.id,{minSelect:Number(e.target.value)})}/></label><label className="field"><span>Máximo</span><input type="number" min="1" max="20" value={group.maxSelect} onChange={(e)=>patchGroup(group.id,{maxSelect:Number(e.target.value)})}/></label><label className="check-field min-h-11"><input type="checkbox" checked={group.required} onChange={(e)=>patchGroup(group.id,{required:e.target.checked,minSelect:e.target.checked?Math.max(1,group.minSelect):group.minSelect})}/>Obligatorio</label><button className="icon-button text-red-700" onClick={()=>removeGroup(group.id)} aria-label="Quitar grupo"><Trash2 className="h-4 w-4"/></button></div><div className="mt-4 space-y-2">{group.options.map((option)=><div className="grid items-end gap-2 rounded-xl bg-stone-50 p-3 sm:grid-cols-[1fr_150px_auto]" key={option.id}><label className="field"><span>Opción</span><input maxLength={120} value={option.name} onChange={(e)=>patchOption(group.id,option.id,{name:e.target.value})}/></label><label className="field"><span>Adicional</span><input type="number" step="0.01" value={option.price} onChange={(e)=>patchOption(group.id,option.id,{price:e.target.value})}/></label><button className="icon-button text-red-700" onClick={()=>patchGroup(group.id,{options:group.options.filter((o)=>o.id!==option.id)})}><Trash2 className="h-4 w-4"/></button></div>)}<button className="button-quiet" onClick={()=>addOption(group.id)}><Plus className="h-4 w-4"/>Agregar opción</button></div></article>)}</div></section>{error?<p className="form-error" role="alert">{error}</p>:null}<div className="flex flex-wrap justify-between gap-3">{!isNew?<button className="button-danger" onClick={()=>void archive()}><Trash2 className="h-4 w-4"/>Dar de baja</button>:<span/>}<button className="button-primary" disabled={saving} onClick={()=>void save()}><Save className="h-4 w-4"/>{saving?'Guardando…':'Guardar producto'}</button></div></div></>
}
