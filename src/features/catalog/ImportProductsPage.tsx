import JSZip from 'jszip'
import { useQueryClient } from '@tanstack/react-query'
import { FileDown, FileSpreadsheet, RefreshCw, UploadCloud } from 'lucide-react'
import Papa from 'papaparse'
import readXlsxFile, { type SheetData } from 'read-excel-file/browser'
import { useRef, useState, type ChangeEvent } from 'react'
import { z } from 'zod'
import { PageHeader } from '../../components/PageHeader'
import { processImage } from '../../lib/images/processImage'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { csvRecordsToSheet, parseImportSheets, type ImportData } from '../../lib/import-products'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'

const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024
const MAX_ZIP_BYTES = 100 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024
const resultSchema = z.object({
  summary: z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }),
  products: z.array(z.object({ code: z.string(), id: z.string().uuid(), outcome: z.enum(['created', 'updated', 'skipped']) })),
  errors: z.array(z.object({ row: z.number().int().optional(), code: z.string(), message: z.string() })),
})
type ImportResult = z.infer<typeof resultSchema>
interface ImageError { filename: string; message: string }
interface ServerError { code: string; message: string; path?: string; row?: number }
interface Progress { current: number; total: number; label: string }

const edgeErrorSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z0-9_]+$/).max(80),
    message: z.string().min(1).max(300),
    details: z.object({
      fields: z.array(z.object({
        path: z.string().max(160),
        message: z.string().min(1).max(300),
      })).max(50),
    }).optional(),
  }),
})

function serverFieldLocation(path: string) {
  const match = /^(products|groups|options)\.(\d+)(?:\.(.+))?$/.exec(path)
  if (!match) return { path }
  return { path, row: Number(match[2]) + 2 }
}

export function ImportProductsPage() {
  const scope = useRestaurantScope()
  const queryClient = useQueryClient()
  const [data, setData] = useState<ImportData | null>(null)
  const [fileName, setFileName] = useState('')
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'create_or_update' | 'create_only' | 'skip_existing'>('create_or_update')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [imageErrors, setImageErrors] = useState<ImageError[]>([])
  const [serverErrors, setServerErrors] = useState<ServerError[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const spreadsheetSelection = useRef(0)

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const selection = ++spreadsheetSelection.current
    setData(null)
    setFileName('')
    setError(null)
    setResult(null)
    setImageErrors([])
    setServerErrors([])
    if (file.size > MAX_SPREADSHEET_BYTES) {
      setError('El archivo de datos supera el límite de 10 MB.')
      return
    }
    try {
      let sheets: Record<string, SheetData>
      if (file.name.toLocaleLowerCase('es').endsWith('.csv')) {
        const parsed = await new Promise<Papa.ParseResult<Record<string, string>>>((resolve, reject) =>
          Papa.parse<Record<string, string>>(file, { header: true, skipEmptyLines: true, complete: resolve, error: reject }),
        )
        if (parsed.errors.length) throw new Error('CSV inválido')
        sheets = { Productos: csvRecordsToSheet(parsed.data) }
      } else {
        const workbook = await readXlsxFile<number>(file)
        sheets = Object.fromEntries(workbook.map((sheet) => [sheet.sheet, sheet.data]))
      }
      if (selection !== spreadsheetSelection.current) return
      setData(parseImportSheets(sheets))
      setFileName(file.name)
    } catch {
      if (selection !== spreadsheetSelection.current) return
      setError('No pudimos leer el archivo. Usá la plantilla XLSX o un CSV válido.')
    }
  }

  function chooseZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    setImageErrors([])
    if (file && file.size > MAX_ZIP_BYTES) {
      setZipFile(null)
      setError('El ZIP supera el límite comprimido de 100 MB.')
      event.target.value = ''
      return
    }
    setError(null)
    setZipFile(file)
  }

  async function uploadImages(imported: ImportResult, preparedZip?: JSZip) {
    if (!data || !zipFile || !scope.selected) return
    const restaurantId = scope.selected.id
    const cleanupAsset = async (path: string) => {
      const { error: storageError } = await supabase.storage.from('restaurant-assets').remove([path])
      if (storageError) return 'El archivo quedó pendiente de limpieza.'
      const { error: metadataError } = await supabase
        .from('image_assets')
        .update({ deleted_at: new Date().toISOString() })
        .eq('restaurant_id', restaurantId)
        .eq('path', path)
      return metadataError ? 'El archivo se eliminó, pero su registro quedó pendiente de limpieza.' : null
    }
    const acceptedCodes = new Set(imported.products.filter((product) => product.outcome !== 'skipped').map((product) => product.code.toLocaleLowerCase('es')))
    const imageProducts = data.products.filter((product) => product.imageFilename && acceptedCodes.has(product.code.toLocaleLowerCase('es')))
    if (!imageProducts.length) return
    const failures: ImageError[] = []
    let extractedBytes = 0
    const zip = preparedZip ?? await JSZip.loadAsync(zipFile)
    const idByCode = new Map(imported.products.filter((product) => product.outcome !== 'skipped').map((product) => [product.code.toLocaleLowerCase('es'), product.id]))
    const ids = [...idByCode.values()]
    const currentImagesResult = ids.length
      ? await supabase.from('products').select('id,image_path').in('id', ids)
          .eq('restaurant_id', restaurantId)
      : { data: [], error: null }
    if (currentImagesResult.error) {
      setImageErrors([{
        filename: 'Imágenes del ZIP',
        message: 'No se pudieron consultar las imágenes actuales; no se subió ningún archivo. Podés reintentar sin repetir la metadata.',
      }])
      return
    }
    const oldPathById = new Map((currentImagesResult.data ?? []).map((product) => [product.id, product.image_path]))

    for (const [index, product] of imageProducts.entries()) {
      const filename = product.imageFilename ?? ''
      setProgress({ current: index + 1, total: imageProducts.length, label: filename })
      const productId = idByCode.get(product.code.toLocaleLowerCase('es'))
      const entry = zip.file(filename.replaceAll('\\', '/'))
      if (!productId || !entry || entry.dir) {
        failures.push({ filename, message: 'No se encontró el archivo o el producto importado.' })
        continue
      }
      try {
        const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
        if (declaredSize !== undefined && declaredSize > 15 * 1024 * 1024) throw new Error('La imagen supera 15 MB.')
        if (declaredSize !== undefined && extractedBytes + declaredSize > MAX_EXTRACTED_BYTES) throw new Error('El contenido extraído supera 250 MB.')
        const bytes = await entry.async('uint8array')
        extractedBytes += bytes.byteLength
        if (bytes.byteLength > 15 * 1024 * 1024) throw new Error('La imagen supera 15 MB.')
        if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('El contenido extraído supera 250 MB.')
        const extension = filename.split('.').pop()?.toLocaleLowerCase('es')
        const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : null
        if (!mimeType) throw new Error('El formato no es JPEG, PNG o WebP.')
        const imageBytes = Uint8Array.from(bytes)
        const processed = await processImage(new File([imageBytes.buffer], filename, { type: mimeType }))
        const path = await uploadRestaurantImage({ restaurantId, kind: 'products', entityId: productId, image: processed })
        const { error: updateError } = await supabase.from('products').update({ image_path: path }).eq('id', productId).eq('restaurant_id', restaurantId).select('id').single()
        if (updateError) {
          const cleanupError = await cleanupAsset(path)
          throw new Error(`No se pudo asociar la imagen.${cleanupError ? ` ${cleanupError}` : ''}`)
        }
        const oldPath = oldPathById.get(productId)
        if (oldPath && oldPath !== path) {
          const cleanupError = await cleanupAsset(oldPath)
          if (cleanupError) failures.push({ filename, message: `La imagen nueva quedó guardada. ${cleanupError}` })
        }
      } catch (uploadError) {
        failures.push({ filename, message: uploadError instanceof Error ? uploadError.message : 'No se pudo procesar o subir la imagen.' })
      }
    }
    setImageErrors(failures)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['products', scope.selected.id] }),
      queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
    ])
  }

  async function runImport() {
    if (!data || !scope.selected || data.errors.length) return
    setBusy(true)
    setError(null)
    setResult(null)
    setImageErrors([])
    setServerErrors([])
    setProgress({ current: 0, total: data.products.length, label: 'Validando metadata' })
    try {
      let preparedZip: JSZip | undefined
      if (zipFile) {
        setProgress({ current: 0, total: data.products.length, label: 'Validando ZIP de imágenes' })
        try {
          preparedZip = await JSZip.loadAsync(zipFile)
        } catch {
          setError('No pudimos abrir el ZIP de imágenes. La metadata no fue importada.')
          return
        }
        setProgress({ current: 0, total: data.products.length, label: 'Validando metadata' })
      }
      const { data: response, error: invokeError } = await supabase.functions.invoke('import-products', {
        body: { restaurantId: scope.selected.id, mode, products: data.products, groups: data.groups, options: data.options },
      })
      if (invokeError) {
        let reported: ServerError[] = [{
          code: 'EDGE_REQUEST_FAILED',
          message: 'La validación del servidor rechazó la importación.',
        }]
        const context = (invokeError as { context?: unknown }).context
        if (context instanceof Response) {
          try {
            const payload = edgeErrorSchema.safeParse(await context.clone().json())
            if (payload.success) {
              const fields = payload.data.error.details?.fields ?? []
              reported = fields.length
                ? fields.map((field) => ({
                    code: payload.data.error.code,
                    message: field.message,
                    ...serverFieldLocation(field.path),
                  }))
                : [{ code: payload.data.error.code, message: payload.data.error.message }]
            }
          } catch {
            // Keep the generic, non-sensitive report when the response is not JSON.
          }
        }
        setServerErrors(reported)
        throw invokeError
      }
      const imported = resultSchema.parse(response)
      setResult(imported)
      if (!imported.errors.length) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['products', scope.selected.id] }),
          queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
        ])
        await uploadImages(imported, preparedZip)
      }
    } catch {
      setError('La importación no se pudo completar. Ningún error interno fue expuesto.')
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  async function retryImages() {
    if (!result) return
    setBusy(true)
    setError(null)
    setImageErrors([])
    try {
      await uploadImages(result)
    } catch {
      setError('No se pudo volver a abrir el ZIP. Seleccionalo otra vez e intentá de nuevo.')
    } finally {
      setProgress(null)
      setBusy(false)
    }
  }

  function downloadErrorReport() {
    const rows = [
      ...(data?.errors ?? []).map((message) => ({ source: 'validación', row: '', code: '', field: '', message })),
      ...(result?.errors ?? []).map((item) => ({ source: 'servidor', row: item.row ?? '', code: item.code, field: '', message: item.message })),
      ...serverErrors.map((item) => ({ source: 'servidor', row: item.row ?? '', code: item.code, field: item.path ?? '', message: item.message })),
      ...imageErrors.map((item) => ({ source: 'imagen', row: '', code: '', field: item.filename, message: item.message })),
    ]
    const safe = (value: unknown) => {
      const text = String(value ?? '')
      const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text
      return `"${protectedText.replaceAll('"', '""')}"`
    }
    const csv = [['origen', 'fila', 'codigo', 'campo_archivo', 'mensaje'], ...rows.map((row) => [row.source, row.row, row.code, row.field, row.message])]
      .map((row) => row.map(safe).join(','))
      .join('\r\n')
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'reporte-errores-importacion.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const reportCount = (data?.errors.length ?? 0) + (result?.errors.length ?? 0) + serverErrors.length + imageErrors.length
  const referencedImages = data?.products.filter((product) => product.imageFilename).length ?? 0

  return <>
    <PageHeader eyebrow="Catálogo" title="Importación masiva" description="La prevalidación ocurre en el navegador y la Edge Function vuelve a validar tenant, rol, códigos e importes dentro de una transacción." />
    <section className="form-card"><div className="grid gap-5 sm:grid-cols-2"><label className="upload-zone"><FileSpreadsheet className="h-10 w-10 text-orange-600"/><strong>Seleccionar XLSX o CSV</strong><small>{fileName||'Hasta 500 productos · máximo 10 MB'}</small><input className="sr-only" type="file" disabled={busy} accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event)=>void choose(event)}/></label><label className="upload-zone"><UploadCloud className="h-10 w-10 text-orange-600"/><strong>ZIP de imágenes (opcional)</strong><small>{zipFile?.name??'Hasta 100 MB; nombres según imagen_archivo'}</small><input className="sr-only" type="file" disabled={busy} accept=".zip,application/zip" onChange={chooseZip}/></label></div><div className="mt-5 flex flex-wrap items-end gap-4"><label className="field max-w-xs flex-1"><span>Si el código ya existe</span><select value={mode} disabled={busy} onChange={(event)=>setMode(event.target.value as typeof mode)}><option value="create_or_update">Actualizar</option><option value="create_only">Informar error</option><option value="skip_existing">Omitir</option></select></label><a className="button-secondary" href="/templates/importacion-productos.xlsx" download>Descargar plantilla</a>{reportCount?<button className="button-secondary" onClick={downloadErrorReport}><FileDown className="h-4 w-4"/>Descargar errores</button>:null}</div></section>
    {data?<section className="mt-6 rounded-3xl border border-stone-200 bg-white p-5"><h2 className="font-display text-xl font-bold">Vista previa</h2><div className="mt-4 grid gap-3 sm:grid-cols-4"><p className="metric-mini"><strong>{data.products.length}</strong>productos</p><p className="metric-mini"><strong>{data.groups.length}</strong>grupos</p><p className="metric-mini"><strong>{data.options.length}</strong>opciones</p><p className="metric-mini"><strong>{referencedImages}</strong>imágenes</p></div>{data.errors.length?<div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-900" role="alert"><strong>Corregí estos errores antes de importar:</strong><ul className="mt-2 list-disc pl-5">{data.errors.slice(0,50).map((item,index)=><li key={`${item}-${index}`}>{item}</li>)}</ul></div>:<div className="mt-5 overflow-x-auto"><table className="data-table"><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Imagen</th></tr></thead><tbody>{data.products.slice(0,20).map((product)=><tr key={product.code}><td>{product.code}</td><td>{product.name}</td><td>{product.category}</td><td>{(product.basePriceCents/100).toFixed(2)}</td><td>{product.imageFilename??'—'}</td></tr>)}</tbody></table></div>}{referencedImages&&!zipFile?<p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Hay imágenes referenciadas, pero no seleccionaste un ZIP. La metadata puede importarse y las imágenes reintentarse después.</p>:null}<button className="button-primary mt-5" disabled={busy||data.errors.length>0} onClick={()=>void runImport()}>{busy?'Importando…':'Importar catálogo'}</button>{progress?<div className="mt-4" role="status"><div className="flex justify-between text-xs text-stone-500"><span>{progress.label}</span><span>{progress.current}/{progress.total}</span></div><progress className="mt-2 w-full" value={progress.current} max={Math.max(1,progress.total)}/></div>:null}</section>:null}
    {error?<p className="form-error mt-5" role="alert">{error}</p>:null}
    {serverErrors.length?<div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-950" role="alert"><strong>Detalle seguro del rechazo:</strong><ul className="mt-2 list-disc pl-5">{serverErrors.map((item,index)=><li key={`${item.code}-${item.path??index}`}>{item.row?`Fila ${item.row} · `:''}{item.path?`${item.path}: `:''}{item.message} <span className="font-mono text-xs">({item.code})</span></li>)}</ul></div>:null}
    {result?<div className={`mt-5 rounded-2xl p-4 text-sm ${result.errors.length?'bg-amber-50 text-amber-950':'form-success'}`} role="status">Importación terminada: {result.summary.created} creados, {result.summary.updated} actualizados y {result.summary.skipped} omitidos.{result.errors.length?` ${result.errors.length} filas requieren revisión.`:''}{result.errors.length?<ul className="mt-2 list-disc pl-5">{result.errors.slice(0,50).map((item,index)=><li key={`${item.code}-${item.row??index}`}>{item.row?`Fila ${item.row}: `:''}{item.message}</li>)}</ul>:null}</div>:null}
    {imageErrors.length?<div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-950"><strong>{imageErrors.length} imágenes no pudieron procesarse.</strong><ul className="mt-2 list-disc pl-5">{imageErrors.slice(0,50).map((item,index)=><li key={`${item.filename}-${index}`}>{item.filename}: {item.message}</li>)}</ul><button className="button-secondary mt-4" disabled={busy||!zipFile} onClick={()=>void retryImages()}><RefreshCw className="h-4 w-4"/>Reintentar imágenes</button></div>:null}
  </>
}
