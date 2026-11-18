import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PublicCatalogMeta } from '../../types/domain'

export function StoreCategoryFilters({ categories, selectedId, onSelect }: {
  categories: PublicCatalogMeta['categories']
  selectedId: string
  onSelect: (id: string) => void
}) {
  const trackRef = useRef<HTMLElement>(null)
  const previousSelection = useRef(selectedId)
  const [overflow, setOverflow] = useState({ before: false, after: false })

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const before = track.scrollLeft > 2
      const after = track.scrollLeft + track.clientWidth < track.scrollWidth - 2
      setOverflow(previous => previous.before === before && previous.after === after ? previous : { before, after })
    }
    track.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    // ResizeObserver delivers its first measurement after layout. Reading the
    // geometry here forces layout of the entire freshly mounted storefront.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(track)
    const initialFrame = observer ? null : requestAnimationFrame(measure)
    return () => {
      track.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
      if (initialFrame !== null) cancelAnimationFrame(initialFrame)
    }
  }, [categories])

  useEffect(() => {
    const track = trackRef.current
    // The first item is already visible in a newly mounted, unfiltered track.
    if (!selectedId && previousSelection.current === selectedId) return
    previousSelection.current = selectedId
    const active = track?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!track || !active) return
    if (active.offsetLeft < track.scrollLeft || active.offsetLeft + active.offsetWidth > track.scrollLeft + track.clientWidth) {
      track.scrollLeft = Math.max(0, active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2)
    }
  }, [selectedId])

  function scroll(direction: number) {
    const track = trackRef.current
    if (!track) return
    track.scrollBy({ left: direction * track.clientWidth * .75, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  return <div className="store-category-navigation">
    <nav ref={trackRef} className="store-categories" aria-label="Filtrar por categoría">
      <button type="button" aria-pressed={!selectedId} onClick={() => onSelect('')}><LayoutGrid aria-hidden />Todos</button>
      {categories.map(category => <button type="button" key={category.id} aria-pressed={selectedId === category.id} onClick={() => onSelect(category.id)}>{category.name}</button>)}
    </nav>
    {overflow.before || overflow.after ? <div className="store-category-arrows">
      <button type="button" aria-label="Ver categorías anteriores" disabled={!overflow.before} onClick={() => scroll(-1)}><ChevronLeft aria-hidden /></button>
      <button type="button" aria-label="Ver más categorías" disabled={!overflow.after} onClick={() => scroll(1)}><ChevronRight aria-hidden /></button>
    </div> : null}
  </div>
}
