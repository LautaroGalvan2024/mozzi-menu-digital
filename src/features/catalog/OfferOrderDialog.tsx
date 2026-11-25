import { Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { AdminConfirmDialog } from '../../components/AdminConfirmDialog'
import { EmptyState } from '../../components/Feedback'
import { applyOfferMove, OfferOrderList, type OfferMove } from './OfferOrderList'
import { getStoreOfferOrder, OfferOrderConflictError, OfferOrderPermissionError, saveStoreOfferOrder, type StoreOfferItem, type StoreOfferOrder } from './offer-order-api'
import './offer-order.css'

interface Props {
  restaurantId: string
  currency: string
  locale: string
  onClose: () => void
  onSaved: () => void
}

export function OfferOrderDialog({ restaurantId, currency, locale, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const alive = useRef(false)
  const working = useRef(false)
  const moves = useRef<OfferMove[]>([])
  const [snapshot, setSnapshot] = useState<StoreOfferOrder | null>(null)
  const [items, setItems] = useState<StoreOfferItem[]>([])
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<'loading' | 'saving' | 'updating' | null>('loading')
  const [message, setMessage] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const dirty = items.some((item, index) => snapshot?.items[index]?.id !== item.id)
  const blocker = useBlocker(dirty || busy === 'saving')

  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement
    if (!element) return
    alive.current = true
    if (element.showModal) element.showModal()
    else element.open = true
    title.current?.focus()
    const updateConnection = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => {
      alive.current = false
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
      if (element.open && element.close) element.close()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [])

  useEffect(() => {
    if (!dirty && busy !== 'saving') return
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])

  useEffect(() => {
    let active = true
    setBusy('loading')
    setMessage('')
    getStoreOfferOrder(restaurantId).then(result => {
      if (!active) return
      setSnapshot(result)
      setItems(result.items)
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof OfferOrderPermissionError ? error.message : 'No se pudieron cargar las ofertas.')
    }).finally(() => { if (active) setBusy(null) })
    return () => { active = false }
  }, [restaurantId, attempt])

  function move(edit: OfferMove) {
    const next = applyOfferMove(items, edit)
    moves.current.push(edit)
    if (next.every((item, index) => snapshot?.items[index]?.id === item.id)) moves.current = []
    setItems(next)
  }

  async function refreshAfterConflict() {
    setBusy('updating')
    setMessage('')
    try {
      const fresh = await getStoreOfferOrder(restaurantId)
      if (!alive.current) return
      setSnapshot(fresh)
      setItems(moves.current.reduce(applyOfferMove, fresh.items))
      setNeedsRefresh(false)
      setMessage('Las ofertas cambiaron. Revisá la lista actualizada antes de guardar.')
    } catch (error) {
      if (!alive.current) return
      setNeedsRefresh(true)
      setMessage(error instanceof OfferOrderPermissionError ? error.message : 'Las ofertas cambiaron. Actualizá la lista para revisar tus cambios.')
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function save() {
    if (!snapshot || !dirty || working.current || busy || !online || needsRefresh) return
    working.current = true
    setBusy('saving')
    setMessage('')
    try {
      await saveStoreOfferOrder(restaurantId, snapshot.revision, items.map(item => item.id))
      if (alive.current) onSaved()
    } catch (error) {
      if (!alive.current) return
      if (error instanceof OfferOrderConflictError) await refreshAfterConflict()
      else setMessage(error instanceof OfferOrderPermissionError ? error.message : 'No se pudo guardar el orden. Conservamos tus cambios para que puedas volver a intentar.')
    } finally {
      working.current = false
      if (alive.current) setBusy(null)
    }
  }

  function requestClose() {
    if (working.current || busy === 'updating') return
    if (dirty) setDiscard(true)
    else onClose()
  }

  const confirmDiscard = discard || (blocker.state === 'blocked' && !busy)
  return <>
    <dialog ref={dialog} className="modal-card catalog-category-dialog offer-order-dialog" aria-labelledby="offer-order-title" aria-describedby="offer-order-description"
      onCancel={event => { event.preventDefault(); requestClose() }}>
      <header className="catalog-dialog-header">
        <div>
          <h2 ref={title} tabIndex={-1} id="offer-order-title" className="form-card-title">Ordenar ofertas</h2>
          <p id="offer-order-description">Elegí qué productos querés que tus clientes vean primero.</p>
        </div>
        <button className="icon-button" type="button" aria-label="Cerrar" disabled={busy === 'saving' || busy === 'updating'} onClick={requestClose}><X aria-hidden /></button>
      </header>
      <div className="catalog-dialog-content offer-order-content" aria-busy={Boolean(busy)}>
        {busy === 'loading' ? <p role="status" className="catalog-inline-progress">Cargando ofertas…</p> : null}
        {snapshot && items.length === 0 ? <EmptyState title="Todavía no hay ofertas" description="Cuando un producto tenga una oferta vigente en tu tienda, aparecerá acá." /> : null}
        {items.length ? <>
          <div className="offer-order-heading"><h3>Productos en oferta</h3><span>{items.length} {items.length === 1 ? 'producto' : 'productos'}</span></div>
          {items.length > 1 ? <p className="offer-order-hint">Arrastrá los productos o usá las flechas para moverlos.</p> : null}
          <OfferOrderList items={items} currency={currency} locale={locale} disabled={Boolean(busy) || needsRefresh} onMove={move} />
          <p className="offer-order-note"><Info aria-hidden />Este orden solo se aplica a «Ofertas para aprovechar» en tu tienda online.</p>
        </> : null}
      </div>
      <footer className="offer-order-footer">
        {!online ? <p className="offer-order-message" role="status">Sin conexión. Podés guardar cuando vuelvas a conectarte.</p> : null}
        {message ? <div className="offer-order-message" role="alert">
          <p>{message}</p>
          {!snapshot ? <button className="button-secondary" type="button" disabled={!online || Boolean(busy)} onClick={() => setAttempt(value => value + 1)}>Reintentar</button> : null}
          {needsRefresh ? <button className="button-secondary" type="button" disabled={!online || Boolean(busy)} onClick={() => void refreshAfterConflict()}>Actualizar ofertas</button> : null}
        </div> : null}
        <div className="catalog-dialog-actions">
          {busy === 'updating' ? <span role="status">Actualizando ofertas…</span> : null}
          <button className="button-secondary" type="button" disabled={busy === 'saving' || busy === 'updating'} onClick={requestClose}>Cancelar</button>
          <button className="button-primary" type="button" disabled={!dirty || Boolean(busy) || needsRefresh || !online} onClick={() => void save()}>{busy === 'saving' ? 'Guardando…' : 'Guardar orden'}</button>
        </div>
      </footer>
    </dialog>
    {confirmDiscard ? <AdminConfirmDialog title="¿Descartar los cambios?" description="Los cambios en el orden de las ofertas se perderán." confirmLabel="Descartar cambios"
      onCancel={() => { setDiscard(false); if (blocker.state === 'blocked') blocker.reset() }}
      onConfirm={() => { if (blocker.state === 'blocked') blocker.proceed(); else onClose() }} /> : null}
  </>
}
