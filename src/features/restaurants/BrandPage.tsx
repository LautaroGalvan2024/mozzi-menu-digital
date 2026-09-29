import { useQueryClient } from '@tanstack/react-query'
import { Image, Trash2, Upload } from 'lucide-react'
import { useState, type ChangeEvent } from 'react'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { processImage } from '../../lib/images/processImage'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { publicAssetUrl, supabase } from '../../lib/supabase/client'
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
        queryClient.invalidateQueries({ queryKey: ['restaurant', scope.selected.id] }),
        queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
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
        queryClient.invalidateQueries({ queryKey: ['restaurant', scope.selected.id] }),
        queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
      ])
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'No se pudo eliminar la imagen.')
    } finally {
      setBusy(null)
    }
  }

  const logo = publicAssetUrl(query.data.logo_path); const cover = publicAssetUrl(query.data.cover_path)
  return <><PageHeader eyebrow="Marca" title="Logo y portada" description="Las imágenes se redimensionan, se re-codifican a WebP y pierden los metadatos EXIF antes de subir. No se aceptan SVG." /><div className="grid gap-6 lg:grid-cols-2"><ImageCard label="Logo" description="Formato cuadrado recomendado." image={logo} busy={busy==='logo'} inputId="logo-upload" onChange={(event)=>void upload('logo',event)} onRemove={()=>void remove('logo')} /><ImageCard label="Portada" description="Formato horizontal recomendado." image={cover} busy={busy==='cover'} inputId="cover-upload" onChange={(event)=>void upload('cover',event)} onRemove={()=>void remove('cover')} /></div>{error ? <p className="form-error mt-5" role="alert">{error}</p> : null}</>
}

async function removeAsset(path: string, restaurantId: string) {
  const { error: storageError } = await supabase.storage.from('restaurant-assets').remove([path])
  if (storageError) return 'El archivo anterior quedó pendiente de limpieza.'
  const { error: metadataError } = await supabase
    .from('image_assets')
    .update({ deleted_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .eq('path', path)
  return metadataError ? 'El archivo se eliminó, pero su registro quedó pendiente de limpieza.' : null
}

function ImageCard({label,description,image,busy,inputId,onChange,onRemove}:{label:string;description:string;image:string|null;busy:boolean;inputId:string;onChange:(event:ChangeEvent<HTMLInputElement>)=>void;onRemove:()=>void}) {
  return <article className="overflow-hidden rounded-3xl border border-stone-200 bg-white"><div className="grid aspect-[16/9] place-items-center bg-stone-100">{image ? <img src={image} className="h-full w-full object-cover" alt={`${label} actual`} /> : <Image className="h-12 w-12 text-stone-300" aria-hidden />}</div><div className="p-5"><h2 className="font-display text-xl font-bold">{label}</h2><p className="mt-1 text-sm text-stone-500">{description} JPEG, PNG o WebP; máximo original 15 MB.</p><div className="mt-4 flex flex-wrap gap-2"><label className="button-secondary cursor-pointer" htmlFor={inputId}><Upload className="h-4 w-4" aria-hidden />{busy?'Procesando…':'Elegir imagen'}<input id={inputId} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy} onChange={onChange} /></label>{image?<button className="button-danger" type="button" disabled={busy} onClick={onRemove}><Trash2 className="h-4 w-4" aria-hidden />Eliminar</button>:null}</div></div></article>
}
