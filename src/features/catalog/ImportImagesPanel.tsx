import { useQueryClient } from '@tanstack/react-query'
import { UploadCloud } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { matchArchiveProducts, normalizeImageSku, readImageArchive, type ImageArchive, type ImageCatalogProduct } from '../../lib/images/image-archive'
import { imageImportLock, latestImageOnlySession, persistImageOnlySession, prepareImageOnlySession, type ImageOnlySession } from '../../lib/images/image-import-session'
import { loadImageProducts, uploadImageBatch, type ImageUploadFailure, type ImageUploadProgress, type ImageUploadTarget } from '../../lib/images/import-image-batch'

interface DraftRow { filename: string; code: string; excluded: boolean; issue?: string | undefined }
const PAGE_SIZE = 50

export function ImportImagesPanel({ restaurantId, onBusyChange }: { restaurantId: string; onBusyChange: (busy: boolean) => void }) {
  const client = useQueryClient()
  const [archive, setArchive] = useState<ImageArchive | null>(null)
  const [products, setProducts] = useState<ImageCatalogProduct[]>([])
  const [rows, setRows] = useState<DraftRow[]>([])
  const [session, setSession] = useState<ImageOnlySession | null>(null)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<ImageUploadFailure[]>([])
  const [progress, setProgress] = useState<ImageUploadProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [finished, setFinished] = useState(false)
  const [newSession, setNewSession] = useState(false)
  const active = useRef(true)
  const cancelled = useRef(false)
  const request = useRef<AbortController | null>(null)
  const running = useRef(false)

  useEffect(() => {
    active.current = true
    try { setSession(latestImageOnlySession(restaurantId)) } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos recuperar la carga anterior.') }
    return () => { active.current = false; request.current?.abort() }
  }, [restaurantId])

  function updateBusy(value: boolean) { setBusy(value); onBusyChange(value) }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || running.current) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    cancelled.current = false
    setArchive(null); setRows([]); setProducts([]); setError(''); setFailures([]); setFinished(false); setPage(0)
    updateBusy(true)
    try {
      const [nextArchive, nextProducts] = await Promise.all([readImageArchive(file, controller.signal), loadImageProducts(restaurantId, controller.signal)])
      if (!active.current || controller.signal.aborted) return
      const matches = matchArchiveProducts(nextArchive, nextProducts, restaurantId)
      const previous = latestImageOnlySession(restaurantId)
      const recovered = previous?.archiveFingerprint === nextArchive.fingerprint ? previous : null
      const nextRows = nextArchive.files.map(filename => {
        const match = matches.get(filename)!
        const recoveredTarget = recovered?.targets.find(target => target.filename === filename)
        const product = nextProducts.find(item => item.id === (recoveredTarget?.productId ?? match.productId))
        return { filename, code: product?.code ?? '', excluded: !!recovered && !recoveredTarget, issue: match.issue }
      })
      setArchive(nextArchive); setProducts(nextProducts); setRows(nextRows); setSession(recovered); setNewSession(false)
    } catch (failure) {
      if (active.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'No pudimos leer el ZIP.')
    } finally { if (active.current) updateBusy(false) }
  }

  const productByCode = new Map<string, ImageCatalogProduct>()
  const ambiguousCodes = new Set<string>()
  for (const product of products) {
    const code = normalizeImageSku(product.code)
    if (productByCode.has(code) || ambiguousCodes.has(code)) { productByCode.delete(code); ambiguousCodes.add(code) }
    else productByCode.set(code, product)
  }
  const included = rows.filter(row => !row.excluded)
  const targets: ImageUploadTarget[] = included.flatMap(row => {
    const product = productByCode.get(normalizeImageSku(row.code))
    return product ? [{ key: row.filename, filename: row.filename, productId: product.id, expectedPath: product.image_path }] : []
  })
  const counts = new Map<string, number>()
  for (const target of targets) counts.set(target.productId, (counts.get(target.productId) ?? 0) + 1)
  const duplicateProducts = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id))
  const invalid = targets.length !== included.length || duplicateProducts.size > 0
  const completed = Object.values(session?.attempts ?? {}).filter(attempt => attempt.associated).length

  function patchRow(filename: string, patch: Partial<DraftRow>) {
    if (session?.started) return
    setRows(previous => previous.map(row => row.filename === filename ? { ...row, ...patch } : row))
    setSession(null); setFinished(false); setFailures([])
  }

  async function run() {
    if (!archive || !targets.length || invalid || running.current) return
    running.current = true
    cancelled.current = false
    updateBusy(true); setError(''); setFailures([]); setFinished(false)
    try {
      const prepared = await prepareImageOnlySession(restaurantId, archive.fingerprint, archive.fileName, targets, newSession)
      if (!active.current) return
      setSession(prepared); setNewSession(false)
      await imageImportLock(restaurantId, `run:${prepared.id}`, async () => {
        const current = await persistImageOnlySession(prepared)
        current.started = true
        await persistImageOnlySession(current)
        if (!active.current) return
        const errors = await uploadImageBatch({
          restaurantId, archive, targets: current.targets, attempts: current.attempts,
          persist: () => persistImageOnlySession(current),
          isCurrent: () => active.current && !cancelled.current,
          onProgress: value => { if (active.current) setProgress(value) },
        })
        if (active.current) { setFailures(errors); setSession({ ...current }); setFinished(!cancelled.current) }
        await invalidateCatalogQueries(client, restaurantId)
      })
    } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : 'No pudimos confirmar la carga. Podés reintentar el mismo ZIP.') }
    finally { running.current = false; if (active.current) { setProgress(null); updateBusy(false) } }
  }

  function cancel() { cancelled.current = true; request.current?.abort(); setError('Detuvimos la carga. Las imágenes ya guardadas se conservan; podés continuar las pendientes.') }

  async function retry() { await run() }

  async function reviewAgain() {
    if (!archive) return
    updateBusy(true); setError('')
    try {
      const latest = await loadImageProducts(restaurantId)
      if (!active.current) return
      setProducts(latest); setSession(null); setFinished(false); setFailures([]); setNewSession(true)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos actualizar los productos.') }
    finally { if (active.current) updateBusy(false) }
  }

  return <section className="form-card mt-5" aria-labelledby="image-import-title">
    <h2 id="image-import-title" className="text-lg font-semibold">Cargar imágenes de productos existentes</h2>
    <p className="mt-2 text-sm text-stone-600">Usá archivos llamados SKU.png o SKU_descripción.png. Revisá las coincidencias antes de guardar. Esta carga sólo actualiza las imágenes.</p>
    <label className="upload-zone mt-5"><UploadCloud className="h-8 w-8 text-orange-600"/><strong>Seleccionar ZIP de imágenes</strong><small>{archive?.fileName ?? 'JPEG, PNG y WebP · ZIP hasta 100 MB'}</small><input aria-label="ZIP para actualizar imágenes" className="sr-only" type="file" accept=".zip,application/zip" disabled={busy} onChange={event => void choose(event)}/></label>
    {session && !archive ? <p className="mt-4 text-sm" role="status">Hay una carga guardada: {session.fileName}. Volvé a seleccionar ese ZIP para recuperar las imágenes pendientes.</p> : null}
    {busy ? <div className="mt-4 flex items-center gap-3"><p role="status" className="text-sm">{progress ? `${progress.current}/${progress.total} · ${progress.label}` : 'Preparando imágenes…'}</p><button type="button" className="button-secondary" onClick={cancel}>Detener</button></div> : null}
    {archive ? <>
      <p className="mt-4 text-sm" role="status">{archive.files.length} imágenes · {targets.length} asignadas · {rows.filter(row => row.excluded).length} excluidas{archive.ignored.length ? ` · ${archive.ignored.length} archivos adicionales ignorados` : ''}.</p>
      <datalist id={`image-products-${restaurantId}`}>{products.map(product => <option key={product.id} value={product.code}>{product.name}</option>)}</datalist>
      <div className="mt-4 overflow-x-auto"><table className="data-table"><thead><tr><th>Imagen</th><th>Producto / SKU</th><th>Acción</th></tr></thead><tbody>
        {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => {
          const product = productByCode.get(normalizeImageSku(row.code))
          const problem = !row.excluded && (!product ? row.issue ?? 'Elegí un SKU existente o excluí la imagen.' : duplicateProducts.has(product.id) ? 'Hay más de una imagen asignada a este producto.' : null)
          return <tr key={row.filename}><td className="max-w-64 break-words">{row.filename}</td><td><input className="input w-full min-w-32" aria-label={`SKU para ${row.filename}`} list={`image-products-${restaurantId}`} value={row.code} disabled={busy || row.excluded || session?.started} onChange={event => patchRow(row.filename, { code: event.target.value, issue: undefined })}/>{product ? <p className="mt-1 text-xs">{product.name}{product.image_path ? ' · Reemplazará su imagen actual' : ' · Sin imagen actual'}</p> : null}{problem ? <p className="mt-1 text-xs text-red-700">{problem}</p> : null}</td><td><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={row.excluded} disabled={busy || session?.started} onChange={event => patchRow(row.filename, { excluded: event.target.checked })}/>Excluir</label>{session?.attempts[row.filename]?.associated ? <span className="text-xs text-green-700">Guardada</span> : null}</td></tr>
        })}
      </tbody></table></div>
      {rows.length > PAGE_SIZE ? <nav className="mt-3 flex items-center gap-3" aria-label="Páginas de imágenes"><button className="button-secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Anterior</button><span>{page + 1}/{Math.ceil(rows.length / PAGE_SIZE)}</span><button className="button-secondary" disabled={(page + 1) * PAGE_SIZE >= rows.length} onClick={() => setPage(value => value + 1)}>Siguiente</button></nav> : null}
      {invalid ? <p className="mt-4 text-sm text-amber-800">Corregí las asignaciones pendientes o repetidas, o excluí esas imágenes antes de guardar.</p> : null}
      <div className="mt-5 flex flex-wrap gap-3"><button className="button-primary" disabled={busy || invalid || !targets.length} onClick={() => void retry()}>{session?.started ? 'Continuar imágenes pendientes' : 'Guardar imágenes'}</button>{session?.started ? <button className="button-secondary" disabled={busy} onClick={() => void reviewAgain()}>Revisar una nueva carga</button> : null}</div>
      {finished ? <p className="form-success mt-4" role="status">{completed} imágenes guardadas. {failures.length ? `${failures.length} requieren revisión.` : 'La carga terminó.'}</p> : null}
    </> : null}
    {error ? <p className="form-error mt-4" role="alert">{error}</p> : null}
    {failures.length ? <div className="mt-4 rounded-lg bg-amber-50 p-4 text-sm" role="alert"><strong>No pudimos cargar estas imágenes:</strong><ul className="mt-2 list-disc pl-5">{failures.map(failure => <li key={failure.filename}>{failure.filename}: {failure.message}</li>)}</ul></div> : null}
  </section>
}
