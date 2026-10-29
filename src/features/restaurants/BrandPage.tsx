import { useQueryClient } from '@tanstack/react-query'
import { Image, Trash2, Upload } from 'lucide-react'
import { useState, type ChangeEvent } from 'react'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { processImage } from '../../lib/images/processImage'
import { assetVariantPaths, responsiveAssetUrls } from '../../lib/images/responsive'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { queryKeys } from '../../lib/queryKeys'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'

export function BrandPage() {
  const scope = useRestaurantScope(); const query = useRestaurant(scope.selected?.id); const queryClient = useQueryClient()
  const [busy, setBusy] = useState<'logo'|'cover'|null>(null); const [error,setError]=useState<string|null>(null)
  if (query.isLoading) return <LoadingScreen />
  if (!query.data) return <ErrorPanel>{query.error?.message ?? 'No se pudo cargar la marca.'}</ErrorPanel>

  async function upload(kind: 'logo'|'cover', event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file || !scope.selected) return
    setBusy(kind); setError(null)
    try {
      const image = await processImage(file)
      const newPath = await uploadRestaurantImage({ restaurantId: scope.selected.id, kind, image })
      const oldPath = kind === 'logo' ? query.data?.logo_path : query.data?.cover_path
      const update = kind === 'logo' ? { logo_path: newPath } : { cover_path: newPath }
      const { error: updateError } = await supabase.from('restaurants').update(update).eq('id', scope.selected.id).select('id').single()
      if (updateError) {
        const cleanupError = await removeAsset(newPath, scope.selected.id)
        throw new Error(`No se pudo asociar la imagen.${cleanupError ? ` ${cleanupError}` : ''}`)
      }
      if (oldPath) {
        const cleanupError = await removeAsset(oldPath, scope.selected.id)
        if (cleanupError) setError(`La imagen nueva quedó guardada. ${cleanupError}`)
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.restaurant(scope.selected.id) }),
        invalidateCatalogQueries(queryClient, scope.selected.id),
      ])
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : 'No se pudo procesar la imagen.') }
    finally { setBusy(null); event.target.value = '' }
  }

  async function remove(kind: 'logo'|'cover') {
    if (!scope.selected || busy) return
    const path = kind === 'logo' ? query.data?.logo_path : query.data?.cover_path
    if (!path || !window.confirm(`¿Eliminar ${kind === 'logo' ? 'el logo' : 'la portada'} actual?`)) return
    setBusy(kind); setError(null)
    try {
      const update = kind === 'logo' ? { logo_path: null } : { cover_path: null }
      const { error: updateError } = await supabase
        .from('restaurants')
        .update(update)
        .eq('id', scope.selected.id)
        .select('id')
        .single()
      if (updateError) throw new Error('No se pudo quitar la imagen del restaurante.')

      const cleanupError = await removeAsset(path, scope.selected.id)
      if (cleanupError) setError(`La imagen se quitó de la marca. ${cleanupError}`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.restaurant(scope.selected.id) }),
        invalidateCatalogQueries(queryClient, scope.selected.id),
      ])
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'No se pudo eliminar la imagen.')
    } finally {
      setBusy(null)
    }
  }

  const logo = responsiveAssetUrls(query.data.logo_path); const cover = responsiveAssetUrls(query.data.cover_path)
  return <><PageHeader eyebrow="Marca" title="Logo y portada" description="Personalizá la imagen que tus clientes ven en el menú y la tienda." /><div className="grid gap-6 lg:grid-cols-2"><ImageCard label="Logo" description="Usá una imagen cuadrada y reconocible." image={logo} busy={busy==='logo'} inputId="logo-upload" onChange={(event)=>void upload('logo',event)} onRemove={()=>void remove('logo')} /><ImageCard label="Portada" description="Elegí una foto horizontal que represente tu comercio." image={cover} busy={busy==='cover'} inputId="cover-upload" onChange={(event)=>void upload('cover',event)} onRemove={()=>void remove('cover')} /></div>{error ? <p className="form-error mt-5" role="alert">{error}</p> : null}</>
}

async function removeAsset(path: string, restaurantId: string) {
  const paths = assetVariantPaths(path)
  const { error: storageError } = await supabase.storage.from('restaurant-assets').remove(paths)
  if (storageError) return 'El archivo anterior quedó pendiente de limpieza.'
  const { error: metadataError } = await supabase
    .from('image_assets')
    .update({ deleted_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .in('path', paths)
  return metadataError ? 'El archivo se eliminó, pero su registro quedó pendiente de limpieza.' : null
}

function ImageCard({label,description,image,busy,inputId,onChange,onRemove}:{label:string;description:string;image:ReturnType<typeof responsiveAssetUrls>;busy:boolean;inputId:string;onChange:(event:ChangeEvent<HTMLInputElement>)=>void;onRemove:()=>void}) {
  return <article className="overflow-hidden rounded-3xl border border-stone-200 bg-white"><div className="grid aspect-[16/9] place-items-center bg-stone-100">{image.src ? <img src={image.src} srcSet={image.srcSet} sizes="(min-width: 1024px) 50vw, 100vw" decoding="async" className="h-full w-full object-cover" alt={`${label} actual`} /> : <Image className="h-12 w-12 text-stone-300" aria-hidden />}</div><div className="p-5"><h2 className="font-display text-xl font-bold">{label}</h2><p className="mt-1 text-sm text-stone-500">{description} JPEG, PNG o WebP; máximo original 15 MB.</p><div className="mt-4 flex flex-wrap gap-2"><label className="button-secondary cursor-pointer" htmlFor={inputId}><Upload className="h-4 w-4" aria-hidden />{busy?'Procesando…':'Elegir imagen'}<input id={inputId} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy} onChange={onChange} /></label>{image.src?<button className="button-danger" type="button" disabled={busy} onClick={onRemove}><Trash2 className="h-4 w-4" aria-hidden />Eliminar</button>:null}</div></div></article>
}
