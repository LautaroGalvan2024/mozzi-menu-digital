import JSZip from 'jszip'
import { useQueryClient } from '@tanstack/react-query'
import { FileDown, FileSpreadsheet, RefreshCw, UploadCloud } from 'lucide-react'
import Papa from 'papaparse'
import readXlsxFile, { type SheetData } from 'read-excel-file/browser'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { z } from 'zod'
import { PageHeader } from '../../components/PageHeader'
import { processImage } from '../../lib/images/processImage'
import { uploadRestaurantImage } from '../../lib/images/upload'
import { csvRecordsToSheet, parseImportSheets, type ImportData } from '../../lib/import-products'
import { importResultSchema, latestImportSession, persistImportSession, prepareImportSession, rejectImportSession, withImportSubmission, type ImportMode, type ImportResult, type ImportSession } from '../../lib/import-session'
import { downloadBlob, importResultWorkbook, importWorkbook } from '../../lib/import-workbook'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'

const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024
const MAX_ZIP_BYTES = 100 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024
// These RPC errors are thrown inside the atomic import transaction, before any
// result can commit. Other failures (including idempotency conflicts) stay uncertain.
const MODE_REJECTION_STATUS: Readonly<Record<string, number>> = { IMPORT_CONFLICT: 409, IMPORT_PRODUCT_NOT_FOUND: 422 }
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
  const [mode, setMode] = useState<ImportMode>('create_or_update')
  const [session, setSession] = useState<ImportSession | null>(null)
  const [recovered, setRecovered] = useState(false)
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [imageErrors, setImageErrors] = useState<ImageError[]>([])
  const [serverErrors, setServerErrors] = useState<ServerError[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const spreadsheetSelection = useRef(0)
  const selectedRestaurantId = scope.selected?.id
  const currentRestaurant = useRef(selectedRestaurantId)

  function applySession(next: ImportSession, restored = false) {
    setSession(next)
    setData(next.data)
    setFileName(next.fileName)
    setMode(next.mode)
    setResult(next.result ?? null)
    setRecovered(restored)
  }

  useEffect(() => {
    currentRestaurant.current = selectedRestaurantId
    spreadsheetSelection.current += 1
    setData(null)
    setSession(null)
    setResult(null)
    setFileName('')
    setZipFile(null)
    setError(null)
    if (!selectedRestaurantId) return
    try {
      const saved = latestImportSession(selectedRestaurantId)
      if (saved) applySession(saved, true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No pudimos recuperar la importación anterior.')
    }
  }, [selectedRestaurantId])

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const selection = ++spreadsheetSelection.current
    setData(null)
    setSession(null)
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
      const parsed = parseImportSheets(sheets)
      if (!scope.selected || parsed.errors.length) {
        setData(parsed)
        setFileName(file.name)
        return
      }
      const prepared = await prepareImportSession(scope.selected.id, parsed, mode, file.name)
      if (selection !== spreadsheetSelection.current) return
      applySession(prepared, prepared.submitted)
    } catch (failure) {
      if (selection !== spreadsheetSelection.current) return
      setError(failure instanceof Error && /registro local|reintento|Liberá espacio|navegador/.test(failure.message) ? failure.message : 'No pudimos leer el archivo. Usá la plantilla XLSX o un CSV válido.')
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

  async function uploadImages(imported: ImportResult, activeSession: ImportSession, preparedZip?: JSZip) {
    if (!zipFile || !scope.selected) return
    const restaurantId = scope.selected.id
    const accepted = new Map(imported.products.filter((product) => product.outcome !== 'skipped').map((product) => [product.rowRef, product.id]))
    const imageProducts = activeSession.data.products.filter((product) => product.imageFilename && accepted.has(product.rowRef) && !activeSession.images[product.rowRef]?.associated)
    if (!imageProducts.length) return
    const failures: ImageError[] = []
    let extractedBytes = 0
    const zip = preparedZip ?? await JSZip.loadAsync(zipFile)
    const ids = [...accepted.values()]
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
      if (currentRestaurant.current !== restaurantId) break
      const filename = product.imageFilename ?? ''
      setProgress({ current: index + 1, total: imageProducts.length, label: filename })
      const productId = accepted.get(product.rowRef)
      const entry = zip.file(filename.replaceAll('\\', '/'))
      if (!productId || !entry || entry.dir) {
        failures.push({ filename, message: 'No se encontró el archivo o el producto importado.' })
        continue
      }
      try {
        let attempt = activeSession.images[product.rowRef]
        const currentPath = oldPathById.get(productId)
        if (currentPath === undefined) throw new Error('No se pudo comprobar la imagen actual del producto. Reintentá sin repetir el catálogo.')
        if (attempt?.path === currentPath) {
          attempt.associated = true
          await persistImportSession(restaurantId, activeSession)
          continue
        }
        if (attempt && attempt.expectedPath !== currentPath) throw new Error('La imagen cambió después de este intento. No se reemplazó; revisá la ficha del producto.')
        if (!attempt) {
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
          attempt = { path, expectedPath: currentPath, associated: false }
          activeSession.images[product.rowRef] = attempt
          // Persist the uploaded path before attempting association. A lost reply
          // can then be reconciled without another upload or unsafe deletion.
          await persistImportSession(restaurantId, activeSession)
        }
        let update = supabase.from('products').update({ image_path: attempt.path }).eq('id', productId).eq('restaurant_id', restaurantId)
        update = attempt.expectedPath === null ? update.is('image_path', null) : update.eq('image_path', attempt.expectedPath)
        const { data: updated, error: updateError } = await update.select('id').maybeSingle()
        if (updateError || !updated) {
          const check = await supabase.from('products').select('image_path').eq('id', productId).eq('restaurant_id', restaurantId).single()
          if (check.error || check.data.image_path !== attempt.path) throw new Error('No pudimos confirmar la asociación de la imagen. Conservamos el archivo para revisar o reintentar; el catálogo ya está importado.')
        }
        attempt.associated = true
        await persistImportSession(restaurantId, activeSession)
        // Retain previous/uncertain assets: another writer may still reference
        // them. Garbage collection requires an authoritative reference check.
      } catch (uploadError) {
        failures.push({ filename, message: uploadError instanceof Error ? uploadError.message : 'No se pudo procesar o subir la imagen.' })
      }
    }
    if (currentRestaurant.current === restaurantId) {
      setImageErrors(failures)
      setSession({ ...activeSession })
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['products', scope.selected.id] }),
      queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
    ])
  }

  async function runImport() {
    if (!data || !scope.selected || data.errors.length || running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    setImageErrors([])
    setServerErrors([])
    setProgress({ current: 0, total: data.products.length, label: 'Validando metadata' })
    try {
      const prepared = session && session.mode === mode ? session : await prepareImportSession(scope.selected.id, data, mode, fileName)
      const restaurantId = scope.selected.id
      await withImportSubmission(restaurantId, prepared, async (activeSession) => {
        setSession(activeSession)
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
        let recoveredResult: unknown = null
        const wasSubmitted = activeSession.submitted
        if (wasSubmitted) {
          const recovery = await supabase.rpc('get_catalog_import_result', { p_restaurant_id: restaurantId, p_batch_id: activeSession.batchId })
          if (recovery.error) throw new Error('No pudimos consultar el resultado anterior. Conservamos el mismo lote para reintentar.')
          recoveredResult = recovery.data
        }
        activeSession.submitted = true
        await persistImportSession(restaurantId, activeSession)
        const { data: response, error: invokeError } = recoveredResult
          ? { data: recoveredResult, error: null }
          : await supabase.functions.invoke('import-products', {
            body: { restaurantId, batchId: activeSession.batchId, mode: activeSession.mode, products: activeSession.data.products, groups: activeSession.data.groups, options: activeSession.data.options },
          })
        if (invokeError) {
          let reported: ServerError[] = [{
            code: 'EDGE_REQUEST_FAILED',
            message: 'No pudimos confirmar el resultado. Reintentá este mismo lote para recuperarlo sin duplicar productos.',
          }]
          const context = (invokeError as { context?: unknown }).context
          let confirmedRejection = false
          if (context instanceof Response) {
            try {
              const payload = edgeErrorSchema.safeParse(await context.clone().json())
              if (payload.success) {
                confirmedRejection = !wasSubmitted && MODE_REJECTION_STATUS[payload.data.error.code] === context.status
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
          if (confirmedRejection) {
            const rejected = await rejectImportSession(restaurantId, activeSession.batchId)
            if (rejected.submitted) throw invokeError
            setSession(rejected)
            setRecovered(false)
            setError('El servidor rechazó la importación sin guardar cambios. Podés corregir el modo y volver a importar.')
            return
          }
          throw invokeError
        }
        const imported = importResultSchema.parse(response)
        if (imported.batchId !== activeSession.batchId || imported.products.length !== activeSession.data.products.length || new Set(imported.products.map((product) => product.rowRef)).size !== imported.products.length || new Set(imported.products.map((product) => product.id)).size !== imported.products.length || imported.products.some((product) => !activeSession.data.products.some((row) => row.rowRef === product.rowRef))) throw new Error('El resultado no corresponde al lote enviado. Conservamos el intento para recuperarlo.')
        activeSession.result = imported
        await persistImportSession(restaurantId, activeSession)
        if (currentRestaurant.current !== restaurantId) return
        setSession({ ...activeSession })
        setResult(imported)
        if (!imported.errors.length) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['products', restaurantId] }),
            queryClient.invalidateQueries({ queryKey: ['public-menu'] }),
          ])
          await uploadImages(imported, activeSession, preparedZip)
        }
      })
    } catch {
      setError('No pudimos confirmar todos los resultados. Conservamos el mismo lote: reintentá para recuperar lo guardado sin duplicar productos.')
    } finally {
      running.current = false
      setProgress(null)
      setBusy(false)
    }
  }

  async function retryImages() {
    if (!result || !session || running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    setImageErrors([])
    try {
      if (!scope.selected) return
      await withImportSubmission(scope.selected.id, session, (current) => uploadImages(current.result ?? result, current))
    } catch {
      setError('No se pudo volver a abrir el ZIP. Seleccionalo otra vez e intentá de nuevo.')
    } finally {
      running.current = false
      setProgress(null)
      setBusy(false)
    }
  }

  async function newImport() {
    if (!data || !scope.selected || busy || !result) return
    try {
      const next = await prepareImportSession(scope.selected.id, data, mode, fileName, true)
      applySession(next)
      setImageErrors([])
      setServerErrors([])
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos preparar la nueva importación.') }
  }

  async function downloadResult() {
    if (!result || !data) return
    downloadBlob(await importResultWorkbook(data, result), 'resultado-importacion.xlsx')
  }

  async function downloadTemplate() {
    downloadBlob(await importWorkbook({
      Productos: [['nombre', 'categoria', 'precio', 'codigo', 'imagen_archivo', 'familia_codigo', 'familia_nombre', 'atributo_1', 'valor_1', 'atributo_2', 'valor_2', 'atributo_3', 'valor_3'], ['Producto de ejemplo', 'General', '100.00', '', '']],
      GruposOpciones: [['producto_fila', 'producto_codigo', 'grupo_codigo', 'nombre', 'obligatorio', 'minimo', 'maximo', 'orden', 'activo']],
      Opciones: [['grupo_codigo', 'opcion_codigo', 'nombre', 'precio_adicional', 'orden', 'activo']],
      Instrucciones: [
        ['Código / SKU (opcional)', 'Si lo dejás vacío, lo generamos automáticamente. La columna codigo puede omitirse.'],
        ['Códigos', 'Usá celdas de texto para conservar ceros iniciales.'],
        ['Precios', 'Ejemplos: 100,50 o 100.50. No uses separadores de miles.'],
        ['Actualizar', 'Usá el resultado descargado: incluye códigos e identificadores. No se comparan nombres.'],
        ['Campos omitidos', 'No se modifican. Una descripción o promoción presente pero vacía se borra; omití su columna para conservarla.'],
        ['Grupos sin SKU', 'producto_fila refiere al número de fila de Productos, por ejemplo 2. grupo_codigo debe ser único en el archivo.'],
        ['Imágenes', 'imagen_archivo indica la ruta dentro del ZIP opcional.'],
        ['Variantes (opcional)', 'Completá familia_codigo y familia_nombre. Repetí ambos en todas las variantes. Cada fila sigue siendo un SKU con su propio precio y stock.'],
        ['Atributos', 'Ejemplo: atributo_1 = Modelo, valor_1 = iPhone 15, atributo_2 = Color, valor_2 = Negro. Hasta tres atributos; no repitas una combinación.'],
        ['Familias existentes', 'Conservá exactamente su nombre, categoría y nombres de atributos. Las columnas vacías no desagrupan productos; usá el panel para cambiar una ficha.'],
      ],
    }), 'importacion-productos.xlsx')
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
    <PageHeader eyebrow="Catálogo" title="Importación masiva" description="Cargá tus productos desde una planilla. Los códigos son opcionales y los campos que no incluyas conservarán su valor actual." />
    <section className="form-card"><div className="grid gap-5 sm:grid-cols-2"><label className="upload-zone"><FileSpreadsheet className="h-10 w-10 text-orange-600"/><strong>Seleccionar XLSX o CSV</strong><small>{fileName||'Hasta 500 productos · máximo 10 MB'}</small><input className="sr-only" type="file" disabled={busy} accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event)=>void choose(event)}/></label><label className="upload-zone"><UploadCloud className="h-10 w-10 text-orange-600"/><strong>ZIP de imágenes (opcional)</strong><small>{zipFile?.name??'Hasta 100 MB; nombres según imagen_archivo'}</small><input className="sr-only" type="file" disabled={busy} accept=".zip,application/zip" onChange={chooseZip}/></label></div><div className="mt-5 flex flex-wrap items-end gap-4"><label className="field max-w-xs flex-1"><span>Cómo importar</span><select value={mode} disabled={busy || !!session?.submitted} onChange={(event)=>setMode(event.target.value as typeof mode)}><option value="create_or_update">Crear o actualizar</option><option value="create_only">Sólo crear nuevos</option><option value="skip_existing">Omitir existentes</option><option value="update_only">Sólo actualizar existentes</option></select></label><button className="button-secondary" onClick={()=>void downloadTemplate()}>Descargar plantilla</button>{reportCount?<button className="button-secondary" onClick={downloadErrorReport}><FileDown className="h-4 w-4"/>Descargar errores</button>:null}</div></section>
    {data?<section className="mt-6 rounded-3xl border border-stone-200 bg-white p-5"><h2 className="font-display text-xl font-bold">Vista previa</h2><p className="mt-3 text-sm">Código / SKU (opcional). Si lo dejás vacío, lo generamos automáticamente.</p>{data.products.some((product)=>!product.code&&!product.id)?<p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm">{data.products.filter((product)=>!product.code&&!product.id).length} filas sin código ni identificador crearán productos nuevos. No se buscan coincidencias por nombre.{mode==='update_only'?' El modo sólo actualizar requiere código o identificador en todas las filas.':''}</p>:null}{recovered?<p className="mt-3 text-sm" role="status">Recuperamos la importación anterior. Continuar consulta su resultado y reintenta el mismo lote.</p>:null}<div className="mt-4 grid gap-3 sm:grid-cols-4"><p className="metric-mini"><strong>{data.products.length}</strong>productos</p><p className="metric-mini"><strong>{data.groups.length}</strong>grupos</p><p className="metric-mini"><strong>{data.options.length}</strong>opciones</p><p className="metric-mini"><strong>{referencedImages}</strong>imágenes</p></div>{data.errors.length?<div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-900" role="alert"><strong>Corregí estos errores antes de importar:</strong><ul className="mt-2 list-disc pl-5">{data.errors.slice(0,50).map((item,index)=><li key={`${item}-${index}`}>{item}</li>)}</ul></div>:<div className="mt-5 overflow-x-auto"><table className="data-table"><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Imagen</th></tr></thead><tbody>{data.products.slice(0,20).map((product)=><tr key={product.rowRef}><td>{product.code || (product.id ? 'Se conserva' : 'Automático')}</td><td>{product.name}</td><td>{product.category}</td><td>{(product.basePriceCents/100).toFixed(2)}</td><td>{product.imageFilename??'—'}</td></tr>)}</tbody></table></div>}{referencedImages&&!zipFile?<p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Hay imágenes referenciadas, pero no seleccionaste un ZIP. La metadata puede importarse y las imágenes reintentarse después.</p>:null}<button className="button-primary mt-5" disabled={busy||data.errors.length>0||(mode==='update_only'&&data.products.some((product)=>!product.code&&!product.id))} onClick={()=>void runImport()}>{busy?'Importando…':session?.submitted?'Recuperar o continuar importación':'Importar catálogo'}</button>{progress?<div className="mt-4" role="status"><div className="flex justify-between text-xs text-stone-500"><span>{progress.label}</span><span>{progress.current}/{progress.total}</span></div><progress className="mt-2 w-full" value={progress.current} max={Math.max(1,progress.total)}/></div>:null}</section>:null}
    {result?<div className="mt-5 flex flex-wrap gap-3"><button className="button-secondary" onClick={()=>void downloadResult()}><FileDown className="h-4 w-4"/>Descargar resultado</button><button className="button-secondary" disabled={busy} onClick={()=>void newImport()}>Iniciar otra importación con estos datos</button><p className="w-full text-sm">Una nueva importación creará nuevos productos para las filas sin código ni identificador. Para actualizar, usá el archivo de resultado.</p></div>:null}{result&&referencedImages?<button className="button-secondary mt-4" disabled={busy||!zipFile} onClick={()=>void retryImages()}>Continuar imágenes pendientes</button>:null}{error?<p className="form-error mt-5" role="alert">{error}</p>:null}
    {serverErrors.length?<div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-950" role="alert"><strong>Detalle seguro del rechazo:</strong><ul className="mt-2 list-disc pl-5">{serverErrors.map((item,index)=><li key={`${item.code}-${item.path??index}`}>{item.row?`Fila ${item.row} · `:''}{item.path?`${item.path}: `:''}{item.message} <span className="font-mono text-xs">({item.code})</span></li>)}</ul></div>:null}
    {result?<div className={`mt-5 rounded-2xl p-4 text-sm ${result.errors.length?'bg-amber-50 text-amber-950':'form-success'}`} role="status">Importación terminada: {result.summary.created} creados, {result.summary.updated} actualizados y {result.summary.skipped} omitidos.{result.errors.length?` ${result.errors.length} filas requieren revisión.`:''}{result.errors.length?<ul className="mt-2 list-disc pl-5">{result.errors.slice(0,50).map((item,index)=><li key={`${item.code}-${item.row??index}`}>{item.row?`Fila ${item.row}: `:''}{item.message}</li>)}</ul>:null}</div>:null}
    {imageErrors.length?<div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-950"><strong>{imageErrors.length} imágenes no pudieron procesarse.</strong><ul className="mt-2 list-disc pl-5">{imageErrors.slice(0,50).map((item,index)=><li key={`${item.filename}-${index}`}>{item.filename}: {item.message}</li>)}</ul><button className="button-secondary mt-4" disabled={busy||!zipFile} onClick={()=>void retryImages()}><RefreshCw className="h-4 w-4"/>Reintentar imágenes</button></div>:null}
  </>
}
