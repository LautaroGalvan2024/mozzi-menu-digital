import { Download, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { chooseZipDestination, type ZipDestination } from '../../lib/images/zip-destination'
import type { ImageExportProgress } from '../../lib/images/catalog-export'

export function ProductImagesExport({ restaurantId }: { restaurantId: string }) {
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const urls = useRef<string[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImageExportProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    mounted.current = true
    const downloadUrls = urls.current
    return () => { mounted.current = false; controller.current?.abort(); downloadUrls.forEach(url => URL.revokeObjectURL(url)) }
  }, [])

  async function download() {
    if (controller.current) return
    // Previous downloads have already been handed to the browser. Release their
    // URLs before preparing another ZIP so memory-only exports do not accumulate.
    urls.current.forEach(url => URL.revokeObjectURL(url))
    urls.current.length = 0
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); setError(null); setMessage(null); setProgress({ current: 0, total: 0, label: 'Leyendo todo el catálogo…' })
    let destination: ZipDestination | undefined
    try {
      const filename = `imagenes-catalogo-${new Date().toISOString().slice(0, 10)}.zip`
      // The save picker needs the original user activation, before lazy imports.
      destination = await chooseZipDestination(filename)
      abort.signal.throwIfAborted()
      const { readImageCatalog, writeImageArchive } = await import('../../lib/images/catalog-export')
      const products = await readImageCatalog(restaurantId, abort.signal)
      if (!products.some(product => product.image_path)) {
        await destination.abort()
        if (mounted.current) setMessage(`No hay imágenes para descargar. ${products.length} productos sin imagen.`)
        return
      }
      const result = await writeImageArchive({ restaurantId, products, writable: destination.writable, signal: abort.signal, onProgress: value => { if (mounted.current) setProgress(value) } })
      const blob = await destination.finish()
      abort.signal.throwIfAborted()
      if (blob) {
        const url = URL.createObjectURL(blob)
        urls.current.push(url)
        const link = document.createElement('a')
        link.href = url; link.download = filename; link.click()
      }
      if (mounted.current) {
        const summary = `${result.products.length} imágenes guardadas. ${result.missingImages.length} productos sin imagen.`
        if (result.errors.length) setError(`Descarga incompleta: ${summary} ${result.errors.length} imágenes fallaron; el detalle está en images-manifest.json dentro del ZIP. Volvé a descargar para reintentarlo.`)
        else setMessage(summary)
      }
    } catch (failure) {
      await destination?.abort().catch(() => undefined)
      if (mounted.current) {
        if (abort.signal.aborted || (failure instanceof DOMException && failure.name === 'AbortError')) setMessage('Descarga cancelada.')
        else setError(failure instanceof DOMException && failure.name === 'QuotaExceededError' ? 'No hay espacio local suficiente para preparar el ZIP. Liberá almacenamiento y reintentá.' : failure instanceof Error ? failure.message : 'No se pudo preparar el ZIP.')
      }
    } finally {
      controller.current = null
      if (mounted.current) { setBusy(false); setProgress(null) }
    }
  }

  return <div className="catalog-export-control">
    <button type="button" className="catalog-command-menu-action" disabled={busy} onClick={() => void download()}><Download className="h-4 w-4" aria-hidden />{busy ? 'Preparando ZIP…' : 'Descargar imágenes'}</button>
    <p className="catalog-command-menu-help">Todas las imágenes del catálogo en un único ZIP.</p>
    {busy ? <button type="button" className="catalog-export-cancel" onClick={() => controller.current?.abort()}><X className="h-4 w-4" aria-hidden />Cancelar descarga</button> : null}
    {busy && progress ? <div className="catalog-export-progress" role="status"><p>{progress.label}{progress.total ? ` · ${progress.current}/${progress.total}` : ''}</p><progress value={progress.current} max={Math.max(1, progress.total)} /></div> : null}
    {message ? <p className="catalog-export-message" role="status">{message}</p> : null}
    {error ? <p className="catalog-export-error" role="alert">{error}</p> : null}
  </div>
}
