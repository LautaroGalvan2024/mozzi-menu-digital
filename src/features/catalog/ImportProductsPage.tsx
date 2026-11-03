import { useQueryClient } from '@tanstack/react-query'
import { FileDown, FileSpreadsheet, RefreshCw, UploadCloud } from 'lucide-react'
import type { SheetData } from 'read-excel-file/browser'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { z } from 'zod'
import { PageHeader } from '../../components/PageHeader'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { readImageArchive, resolveArchiveImage, type ImageArchive } from '../../lib/images/image-archive'
import { uploadImageBatch } from '../../lib/images/import-image-batch'
import { ImportImagesPanel } from './ImportImagesPanel'
import type { ImportData } from '../../lib/import-products'
import { readImportFile, MAX_SPREADSHEET_BYTES } from '../../lib/import-file'
import { detectImportMapping, normalizeImportMapping, type ImportMapping } from '../../lib/import-mapping'
import { applyImportProfile, listImportProfiles, matchImportProfile } from '../../lib/import-profiles'
import { importResultSchema, latestImportSession, persistImportSession, prepareImportSession, rejectImportSession, withImportSubmission, type ImportMode, type ImportResult, type ImportSession } from '../../lib/import-session'
import { downloadBlob, importResultWorkbook, importWorkbook } from '../../lib/import-workbook'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { ImportMappingPanel } from './ImportMappingPanel'

// These RPC errors are thrown inside the atomic import transaction, before any
// result can commit. Other failures (including idempotency conflicts) stay uncertain.
const MODE_REJECTION_STATUS: Readonly<Record<string, number>> = { IMPORT_CONFLICT: 409, IMPORT_PRODUCT_NOT_FOUND: 422 }
interface ImageError { filename: string; message: string }
interface ServerError { code: string; message: string; path?: string; row?: string | number }
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

function serverFieldLocation(path: string, data: ImportData) {
  const match = /^(products|groups|options)\.(\d+)(?:\.(.+))?$/.exec(path)
  if (!match) return { path }
  return { path, row: match[1] === 'products' ? data.products[Number(match[2])]?.rowRef ?? Number(match[2]) + 2 : Number(match[2]) + 2 }
}

export function ImportProductsPage() {
  const scope = useRestaurantScope()
  const queryClient = useQueryClient()
  const [data, setData] = useState<ImportData | null>(null)
  const [fileName, setFileName] = useState('')
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [imageArchive, setImageArchive] = useState<ImageArchive | null>(null)
  const [zipReading, setZipReading] = useState(false)
  const [zipError, setZipError] = useState('')
  const [imagesOnly, setImagesOnly] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const zipSelection = useRef(0)
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
  const [sourceSheets, setSourceSheets] = useState<Record<string, SheetData> | null>(null)
  const [mapping, setMapping] = useState<ImportMapping | null>(null)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [matchedProfileName, setMatchedProfileName] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
  const [sourceVersion, setSourceVersion] = useState(0)
  const [mappingNotice, setMappingNotice] = useState('')
  const spreadsheetSelection = useRef(0)
  const selectedRestaurantId = scope.selected?.id
  const currentRestaurant = useRef(selectedRestaurantId)
  const normalized = useMemo(() => sourceSheets && mapping ? normalizeImportMapping(sourceSheets, mapping) : null, [sourceSheets, mapping])

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
    setImageArchive(null)
    setZipError('')
    setZipReading(false)
    setImageBusy(false)
    zipSelection.current += 1
    setError(null)
    setSourceSheets(null)
    setMapping(null)
    setMappingOpen(false)
    setMatchedProfileName(null)
    setReading(false)
    setIdentityConfirmed(false)
    setImageErrors([])
    setServerErrors([])
    setRecovered(false)
    setMappingNotice('')
    setProgress(null)
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
    event.target.value = ''
    const selection = ++spreadsheetSelection.current
    const restaurantId = selectedRestaurantId
    setData(null)
    setSession(null)
    setFileName('')
    setError(null)
    setResult(null)
    setImageErrors([])
    setServerErrors([])
    setSourceSheets(null)
    setMapping(null)
    setMappingOpen(false)
    setMatchedProfileName(null)
    setIdentityConfirmed(false)
    setRecovered(false)
    setReading(false)
    setMappingNotice('')
    if (file.size > MAX_SPREADSHEET_BYTES) {
      setError('El archivo de datos supera el límite de 10 MB.')
      return
    }
    setReading(true)
    try {
      const sheets = await readImportFile(file)
      if (selection !== spreadsheetSelection.current || currentRestaurant.current !== restaurantId) return
      const profiles = restaurantId ? listImportProfiles(restaurantId) : []
      const profile = matchImportProfile(profiles, sheets)
      setSourceSheets(sheets)
      setSourceVersion(selection)
      setMapping(profile ? applyImportProfile(profile, sheets) ?? detectImportMapping(sheets) : detectImportMapping(sheets))
      setMatchedProfileName(profile?.name ?? null)
      setFileName(file.name)
      setMappingOpen(true)
    } catch (failure) {
      if (selection !== spreadsheetSelection.current) return
      setError(failure instanceof Error ? failure.message : 'No pudimos leer el archivo. Seleccioná un XLS, XLSX, ODS, CSV o TSV válido.')
    } finally {
      if (selection === spreadsheetSelection.current) setReading(false)
    }
  }

  async function reviewMapping(notice = '') {
    if (!normalized || normalized.errors.length || !selectedRestaurantId || reading || busy) return
    const selection = spreadsheetSelection.current
    const restaurantId = selectedRestaurantId
    setReading(true)
    setError(null)
    try {
      const prepared = await prepareImportSession(restaurantId, normalized.data, mode, fileName)
      if (selection !== spreadsheetSelection.current || currentRestaurant.current !== restaurantId) return
      applySession(prepared, prepared.submitted)
      setMappingOpen(false)
      setIdentityConfirmed(false)
      setMappingNotice(notice)
    } catch (failure) {
      if (selection === spreadsheetSelection.current) setError(failure instanceof Error ? failure.message : 'No pudimos preparar la importación.')
    } finally {
      if (selection === spreadsheetSelection.current) setReading(false)
    }
  }

  function editMapping() {
    if (busy || reading || session?.submitted) return
    setData(null)
    setSession(null)
    setResult(null)
    setError(null)
    setServerErrors([])
    setIdentityConfirmed(false)
    setMappingOpen(true)
  }

  async function chooseZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    const selection = ++zipSelection.current
    const restaurantId = selectedRestaurantId
    setImageErrors([]); setImageArchive(null); setZipError(''); setError(null); setZipFile(file)
    if (!file) return
    setZipReading(true)
    try {
      const archive = await readImageArchive(file)
      if (selection !== zipSelection.current || currentRestaurant.current !== restaurantId) return
      setImageArchive(archive)
    } catch (failure) {
      if (selection === zipSelection.current) setZipError(failure instanceof Error ? failure.message : 'No pudimos abrir el ZIP.')
    } finally { if (selection === zipSelection.current) setZipReading(false) }
  }

  async function uploadImages(imported: ImportResult, activeSession: ImportSession, preparedZip?: ImageArchive) {
    if (!zipFile || !scope.selected) return
    const restaurantId = scope.selected.id
    const archive = preparedZip ?? imageArchive ?? await readImageArchive(zipFile)
    const accepted = new Map(imported.products.filter(product => product.outcome !== 'skipped').map(product => [product.rowRef, product.id]))
    const failures: ImageError[] = []
    const targets = activeSession.data.products.flatMap(product => {
      const productId = accepted.get(product.rowRef)
      if (!product.imageFilename || !productId || activeSession.images[product.rowRef]?.associated) return []
      try { return [{ key: product.rowRef, productId, filename: resolveArchiveImage(archive, product.imageFilename) }] }
      catch (failure) { failures.push({ filename: product.imageFilename, message: failure instanceof Error ? failure.message : 'No se encontró la imagen.' }); return [] }
    })
    const errors = await uploadImageBatch({ restaurantId, archive, targets, attempts: activeSession.images,
      persist: () => persistImportSession(restaurantId, activeSession), onProgress: setProgress,
      isCurrent: () => currentRestaurant.current === restaurantId,
    })
    if (currentRestaurant.current === restaurantId) { setImageErrors([...failures, ...errors]); setSession({ ...activeSession }) }
    await invalidateCatalogQueries(queryClient, restaurantId)
  }

  async function runImport() {
    if (!data || !scope.selected || data.errors.length || running.current || mappingOpen || reading || zipReading || !!zipError || (zipFile && (!imageArchive || zipIssues.length > 0)) || (!session?.submitted && data.products.some((product) => !product.code && !product.id) && (!identityConfirmed || mode === 'update_only'))) return
    running.current = true
    setBusy(true)
    setError(null)
    setImageErrors([])
    setServerErrors([])
    setProgress({ current: 0, total: data.products.length, label: 'Validando productos' })
    const restaurantId = scope.selected.id
    try {
      const prepared = session && session.mode === mode ? session : await prepareImportSession(restaurantId, data, mode, fileName)
      if (currentRestaurant.current !== restaurantId) return
      await withImportSubmission(restaurantId, prepared, async (activeSession) => {
        if (currentRestaurant.current !== restaurantId) return
        setSession(activeSession)
        let preparedZip: ImageArchive | undefined
        if (zipFile) {
          setProgress({ current: 0, total: data.products.length, label: 'Validando ZIP de imágenes' })
          try {
            preparedZip = imageArchive ?? await readImageArchive(zipFile)
          } catch {
            setError('No pudimos abrir el ZIP de imágenes. La metadata no fue importada.')
            return
          }
          setProgress({ current: 0, total: data.products.length, label: 'Validando productos' })
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
                      ...serverFieldLocation(field.path, activeSession.data),
                    }))
                  : [{ code: payload.data.error.code, message: payload.data.error.message }]
              }
            } catch {
              // Keep the generic, non-sensitive report when the response is not JSON.
            }
          }
          if (currentRestaurant.current === restaurantId) setServerErrors(reported)
          if (confirmedRejection) {
            const rejected = await rejectImportSession(restaurantId, activeSession.batchId)
            if (rejected.submitted) throw invokeError
            if (currentRestaurant.current !== restaurantId) return
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
            invalidateCatalogQueries(queryClient, restaurantId),
          ])
          await uploadImages(imported, activeSession, preparedZip)
        }
      })
    } catch {
      if (currentRestaurant.current === restaurantId) setError('No pudimos confirmar todos los resultados. Conservamos el mismo lote: reintentá para recuperar lo guardado sin duplicar productos.')
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
    const restaurantId = scope.selected.id
    const selection = spreadsheetSelection.current
    try {
      const next = await prepareImportSession(restaurantId, data, mode, fileName, true)
      if (currentRestaurant.current !== restaurantId || selection !== spreadsheetSelection.current) return
      applySession(next)
      setIdentityConfirmed(false)
      setImageErrors([])
      setServerErrors([])
      setError(null)
    } catch (failure) { if (currentRestaurant.current === restaurantId && selection === spreadsheetSelection.current) setError(failure instanceof Error ? failure.message : 'No pudimos preparar la nueva importación.') }
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
    const validationErrors = mappingOpen ? normalized?.errors ?? [] : data?.errors ?? []
    const rows = [
      ...validationErrors.map((message) => ({ source: 'validación', row: /^Productos fila (\d+):/.exec(message)?.[1] ?? '', code: '', field: '', message })),
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

  const reportCount = (mappingOpen ? normalized?.errors.length ?? 0 : data?.errors.length ?? 0) + (result?.errors.length ?? 0) + serverErrors.length + imageErrors.length
  const referencedImages = data?.products.filter((product) => product.imageFilename).length ?? 0
  const zipIssues = imageArchive && data ? data.products.flatMap(product => {
    if (!product.imageFilename) return []
    try { resolveArchiveImage(imageArchive, product.imageFilename); return [] }
    catch (failure) { return [failure instanceof Error ? failure.message : 'No se encontró la imagen.'] }
  }) : []

  return <>
    <PageHeader eyebrow="Catálogo" title="Importación masiva" description="Subí el archivo de tu comercio, revisá lo que reconocemos y elegí cómo actualizar el catálogo. Podés guardar el formato para las próximas cargas." />
    <div className="mb-5 flex flex-wrap gap-2" aria-label="Tipo de importación"><button type="button" className={imagesOnly ? 'button-secondary' : 'button-primary'} aria-pressed={!imagesOnly} disabled={busy || reading || zipReading || imageBusy} onClick={() => setImagesOnly(false)}>Productos e imágenes</button><button type="button" className={imagesOnly ? 'button-primary' : 'button-secondary'} aria-pressed={imagesOnly} disabled={busy || reading || zipReading || imageBusy} onClick={() => setImagesOnly(true)}>Sólo imágenes</button></div>
    {imagesOnly && selectedRestaurantId ? <ImportImagesPanel key={selectedRestaurantId} restaurantId={selectedRestaurantId} onBusyChange={setImageBusy}/> : <>
    <section className="form-card"><div className="grid gap-5 sm:grid-cols-2"><label className="upload-zone"><FileSpreadsheet className="h-10 w-10 text-orange-600"/><strong>Seleccionar archivo de productos</strong><small>{fileName||'XLS, XLSX, ODS, CSV o TSV · hasta 500 productos · 10 MB'}</small><input className="sr-only" type="file" disabled={busy || reading} accept=".xlsx,.xls,.ods,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.oasis.opendocument.spreadsheet,text/csv,text/tab-separated-values" onChange={(event)=>void choose(event)}/></label><label className="upload-zone"><UploadCloud className="h-10 w-10 text-orange-600"/><strong>ZIP de imágenes (opcional)</strong><small>{zipFile?.name??'Hasta 100 MB; nombres según imagen_archivo'}</small><input className="sr-only" type="file" disabled={busy || zipReading} accept=".zip,application/zip" onChange={event => void chooseZip(event)}/></label></div><div className="mt-5 flex flex-wrap items-end gap-4"><label className="field w-full sm:max-w-xs sm:flex-1"><span>Cómo importar</span><select value={mode} disabled={busy || reading || !!session?.submitted} onChange={(event)=>setMode(event.target.value as typeof mode)}><option value="create_or_update">Crear o actualizar</option><option value="create_only">Sólo crear nuevos</option><option value="skip_existing">Omitir existentes</option><option value="update_only">Sólo actualizar existentes</option></select></label><button className="button-secondary" onClick={()=>void downloadTemplate()}>Descargar plantilla</button>{reportCount?<button className="button-secondary" onClick={downloadErrorReport}><FileDown className="h-4 w-4"/>Descargar errores</button>:null}</div></section>
    {zipReading ? <p className="mt-4 text-sm" role="status">Validando ZIP de imágenes…</p> : null}
    {zipFile ? <button className="button-secondary mt-3" disabled={busy || zipReading} onClick={() => { setZipFile(null); setImageArchive(null); setZipError(''); setImageErrors([]) }}>Quitar ZIP</button> : null}
    {imageArchive ? <p className="mt-4 text-sm" role="status">{imageArchive.files.length} imágenes encontradas en el ZIP{data ? `; ${referencedImages - zipIssues.length} de ${referencedImages} referencias coinciden` : ''}.</p> : null}
    {zipError || zipIssues.length ? <div className="form-error mt-4" role="alert">{zipError ? <p>{zipError} Los productos no se importarán hasta corregir el ZIP.</p> : null}{zipIssues.length ? <ul>{zipIssues.slice(0, 50).map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}</div> : null}
    {reading ? <p className="mt-5 text-sm" role="status">Leyendo y preparando el archivo…</p> : null}
    {mappingOpen && sourceSheets && mapping && normalized && selectedRestaurantId ? <ImportMappingPanel key={`${selectedRestaurantId}:${sourceVersion}`} sheets={sourceSheets} mapping={mapping} normalized={normalized} restaurantId={selectedRestaurantId} fileName={fileName} matchedProfileName={matchedProfileName} busy={busy || reading} onChange={setMapping} onContinue={reviewMapping}/> : null}
    {mappingNotice && !mappingOpen ? <p className="mt-4 text-sm" role="status">{mappingNotice}</p> : null}
    {data && !mappingOpen?<section className="mt-6 rounded-xl border border-stone-200 bg-white p-5"><h2 className="font-display text-xl font-bold">Vista previa</h2><p className="mt-3 text-sm">Actualizamos por código / SKU o identificador. Los productos que no estén en el archivo y los campos sin relacionar conservan su valor actual.</p>{data.products.some((product)=>!product.code&&!product.id)?<p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm">{data.products.filter((product)=>!product.code&&!product.id).length} filas sin código ni identificador crearán productos nuevos. No se buscan coincidencias por nombre.{mode==='update_only'?' El modo sólo actualizar requiere código o identificador en todas las filas.':''}</p>:null}{!session?.submitted && data.products.some((product) => !product.code && !product.id) && mode !== 'update_only' ? <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={identityConfirmed} disabled={busy} onChange={(event) => setIdentityConfirmed(event.target.checked)}/>Entiendo que las filas sin código crearán productos nuevos. Para futuras actualizaciones usaré los códigos del resultado.</label> : null}{recovered?<p className="mt-3 text-sm" role="status">Recuperamos una importación anterior. Continuar consulta su resultado y reintenta el mismo lote. Si ya terminó, no vuelve a aplicar los precios. Para aplicarlos de nuevo, usá «Iniciar otra importación con estos datos» después de recuperar el resultado.</p>:null}<div className="mt-4 grid gap-3 sm:grid-cols-4"><p className="metric-mini"><strong>{data.products.length}</strong>productos</p><p className="metric-mini"><strong>{data.groups.length}</strong>grupos</p><p className="metric-mini"><strong>{data.options.length}</strong>opciones</p><p className="metric-mini"><strong>{referencedImages}</strong>imágenes</p></div>{data.errors.length?<div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-900" role="alert"><strong>Corregí estos errores antes de importar:</strong><ul className="mt-2 list-disc pl-5">{data.errors.slice(0,50).map((item,index)=><li key={`${item}-${index}`}>{item}</li>)}</ul></div>:<div className="mt-5 overflow-x-auto"><table className="data-table"><thead><tr><th>Código</th><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Imagen</th></tr></thead><tbody>{data.products.slice(0,20).map((product)=><tr key={product.rowRef}><td>{product.code || (product.id ? 'Se conserva' : 'Automático')}</td><td>{product.name}</td><td>{product.category}</td><td>{(product.basePriceCents/100).toFixed(2)}</td><td>{product.imageFilename??'—'}</td></tr>)}</tbody></table></div>}{referencedImages&&!zipFile?<p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Hay imágenes referenciadas, pero no seleccionaste un ZIP. Podés importar los productos y cargar las imágenes después.</p>:null}{sourceSheets && !session?.submitted ? <button className="button-secondary mr-3 mt-5" disabled={busy || reading} onClick={editMapping}>Volver a relacionar columnas</button> : null}<button className="button-primary mt-5" disabled={busy||reading||zipReading||!!zipError||!!(zipFile && (!imageArchive || zipIssues.length))||data.errors.length>0||(mode==='update_only'&&data.products.some((product)=>!product.code&&!product.id))||(!session?.submitted&&!identityConfirmed&&data.products.some((product)=>!product.code&&!product.id))} onClick={()=>void runImport()}>{busy?'Importando…':session?.submitted?'Recuperar o continuar importación':'Importar catálogo'}</button>{progress?<div className="mt-4" role="status"><div className="flex justify-between text-xs text-stone-500"><span>{progress.label}</span><span>{progress.current}/{progress.total}</span></div><progress className="mt-2 w-full" value={progress.current} max={Math.max(1,progress.total)}/></div>:null}</section>:null}
    {result?<div className="mt-5 flex flex-wrap gap-3"><button className="button-secondary" onClick={()=>void downloadResult()}><FileDown className="h-4 w-4"/>Descargar resultado</button><button className="button-secondary" disabled={busy} onClick={()=>void newImport()}>Iniciar otra importación con estos datos</button><p className="w-full text-sm">Una nueva importación creará nuevos productos para las filas sin código ni identificador. Para actualizar, usá el archivo de resultado.</p></div>:null}{result&&referencedImages?<button className="button-secondary mt-4" disabled={busy||!zipFile} onClick={()=>void retryImages()}>Continuar imágenes pendientes</button>:null}{error?<p className="form-error mt-5" role="alert">{error}</p>:null}
    {serverErrors.length?<div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-950" role="alert"><strong>Qué necesitás corregir:</strong><ul className="mt-2 list-disc pl-5">{serverErrors.map((item,index)=><li key={`${item.code}-${item.path??index}`}>{item.row?`Fila ${item.row} · `:''}{item.path?`${item.path}: `:''}{item.message} <span className="font-mono text-xs">({item.code})</span></li>)}</ul></div>:null}
    {result?<div className={`mt-5 rounded-2xl p-4 text-sm ${result.errors.length?'bg-amber-50 text-amber-950':'form-success'}`} role="status">{recovered ? 'Resultado recuperado. ' : ''}Importación terminada: {result.summary.created} creados, {result.summary.updated} actualizados y {result.summary.skipped} omitidos.{result.errors.length?` ${result.errors.length} filas requieren revisión.`:''}{result.errors.length?<ul className="mt-2 list-disc pl-5">{result.errors.slice(0,50).map((item,index)=><li key={`${item.code}-${item.row??index}`}>{item.row?`Fila ${item.row}: `:''}{item.message}</li>)}</ul>:null}</div>:null}
    {imageErrors.length?<div className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-950"><strong>{imageErrors.length} imágenes no pudieron procesarse.</strong><ul className="mt-2 list-disc pl-5">{imageErrors.slice(0,50).map((item,index)=><li key={`${item.filename}-${index}`}>{item.filename}: {item.message}</li>)}</ul><button className="button-secondary mt-4" disabled={busy||!zipFile} onClick={()=>void retryImages()}><RefreshCw className="h-4 w-4"/>Reintentar imágenes</button></div>:null}
    </>}
  </>
}
