import { ChevronDown, ChevronUp, GripVertical, ImageIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { formatMoney } from '../../lib/money'
import type { StoreOfferItem } from './offer-order-api'

export interface OfferMove {
  id: string
  target: string
  after: boolean
}

// The target is a stable store card ID so an edit can be reapplied to a fresh list.
export function applyOfferMove(items: StoreOfferItem[], move: OfferMove) {
  const source = items.find(item => item.id === move.id)
  if (!source || move.id === move.target) return items
  const reordered = items.filter(item => item.id !== move.id)
  const target = reordered.findIndex(item => item.id === move.target)
  if (target < 0) return items
  reordered.splice(target + Number(move.after), 0, source)
  return reordered
}

interface Props {
  items: StoreOfferItem[]
  disabled: boolean
  currency: string
  locale: string
  onMove: (move: OfferMove) => void
}

function OfferPhoto({ item }: { item: StoreOfferItem }) {
  const [src, setSrc] = useState(item.image_url)
  return src ? <img alt="" draggable={false} src={src} loading="lazy" decoding="async"
    onError={() => setSrc(src === item.original_url ? null : item.original_url ?? null)} /> : <ImageIcon aria-hidden />
}

export function OfferOrderList({ items, disabled, currency, locale, onMove }: Props) {
  const list = useRef<HTMLOListElement>(null)
  const pointer = useRef<{ id: string, x: number, y: number, pointerId: number } | null>(null)
  const restoreFocus = useRef<{ id: string, direction: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  function rowAt(x: number, y: number) {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-offer-id]')
    return row && list.current?.contains(row) ? row.dataset.offerId ?? null : null
  }

  useEffect(() => {
    const scroll = list.current?.parentElement
    if (!dragging || !scroll) return
    let frame = 0
    function autoScroll() {
      const point = pointer.current
      if (!scroll || !point) return
      const bounds = scroll.getBoundingClientRect()
      if (point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
        const edge = 44
        const top = point.y - bounds.top
        const bottom = bounds.bottom - point.y
        const distance = top < edge ? top - edge : bottom < edge ? edge - bottom : 0
        if (distance) {
          scroll.scrollTop += distance / 4
          setTarget(rowAt(point.x, point.y))
        }
      }
      frame = requestAnimationFrame(autoScroll)
    }
    frame = requestAnimationFrame(autoScroll)
    return () => cancelAnimationFrame(frame)
  }, [dragging])

  useLayoutEffect(() => {
    const focus = restoreFocus.current
    if (!focus) return
    restoreFocus.current = null
    const row = Array.from(list.current?.children ?? []).find(item => (item as HTMLElement).dataset.offerId === focus.id)
    const button = row?.querySelector<HTMLButtonElement>(`[data-direction="${focus.direction}"]:enabled`) ?? row?.querySelector<HTMLButtonElement>('button:enabled')
    button?.focus({ preventScroll: true })
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [items])

  function move(from: number, to: number, direction?: string) {
    const source = items[from]
    const destination = items[to]
    if (disabled || !source || !destination || from === to) return
    if (direction) restoreFocus.current = { id: source.id, direction }
    onMove({ id: source.id, target: destination.id, after: from < to })
    setAnnouncement(`${source.name}, posición ${to + 1} de ${items.length}.`)
  }

  function stopDrag() {
    pointer.current = null
    setDragging(null)
    setTarget(null)
  }

  function drop(event: PointerEvent<HTMLSpanElement>) {
    const point = pointer.current
    if (!point || point.pointerId !== event.pointerId) return
    const destination = rowAt(event.clientX, event.clientY)
    if (destination) move(items.findIndex(item => item.id === point.id), items.findIndex(item => item.id === destination))
    stopDrag()
  }

  return <>
    <ol ref={list} aria-label="Productos en oferta" className="offer-order-list">
      {items.map((item, index) => <li
        key={item.id}
        data-offer-id={item.id}
        data-dragging={dragging === item.id || undefined}
        data-drop={dragging && dragging !== item.id && target === item.id ? 'target' : undefined}
      >
        <span className="offer-order-grip" role="img" aria-label={items.length > 1 ? `Arrastrar ${item.name}` : 'Primera posición'}
          onPointerDown={event => {
            if (disabled || items.length < 2 || !event.isPrimary || event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            pointer.current = { id: item.id, x: event.clientX, y: event.clientY, pointerId: event.pointerId }
            setDragging(item.id)
          }}
          onPointerMove={event => {
            if (pointer.current?.pointerId !== event.pointerId) return
            pointer.current.x = event.clientX
            pointer.current.y = event.clientY
            setTarget(rowAt(event.clientX, event.clientY))
          }}
          onPointerUp={drop} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
        >
          <span aria-hidden>{index + 1}</span>
          {items.length > 1 ? <GripVertical aria-hidden /> : null}
        </span>
        <span className="offer-order-photo">
          <OfferPhoto key={item.image_url} item={item} />
        </span>
        <span className="offer-order-product">
          <span className="sr-only">Posición {index + 1} de {items.length}.</span>
          <strong>{item.name}</strong>
          <span>{formatMoney(item.price, currency, locale)}</span>
          {index === 0 ? <small>Se muestra primero</small> : null}
        </span>
        <span className="offer-order-arrows">
          <button className="icon-button" type="button" data-direction="up" aria-label={`Subir ${item.name}`} disabled={disabled || index === 0} onClick={() => move(index, index - 1, 'up')}><ChevronUp aria-hidden /></button>
          <button className="icon-button" type="button" data-direction="down" aria-label={`Bajar ${item.name}`} disabled={disabled || index === items.length - 1} onClick={() => move(index, index + 1, 'down')}><ChevronDown aria-hidden /></button>
        </span>
      </li>)}
    </ol>
    <span role="status" className="sr-only">{announcement}</span>
  </>
}
