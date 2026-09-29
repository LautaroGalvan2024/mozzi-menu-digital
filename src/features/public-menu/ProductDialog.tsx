import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney, currentProductPrice } from '../../lib/money'
import { publicAssetUrl } from '../../lib/supabase/client'
import type { CartLine, PublicProduct, PublicRestaurant } from '../../types/domain'

export function ProductDialog({ product, restaurant, onClose, onAdd }: { product: PublicProduct; restaurant: PublicRestaurant; onClose: () => void; onAdd: (line: CartLine) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState('')
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const basePrice = currentProductPrice(product)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    const handleClose = () => onClose()
    dialog.addEventListener('close', handleClose)
    return () => dialog.removeEventListener('close', handleClose)
  }, [onClose])

  const selectedOptions = useMemo(
    () =>
      product.optionGroups.flatMap((group) =>
        group.options
          .filter((option) => selections[group.id]?.includes(option.id))
          .map((option) => ({ id: option.id, groupName: group.name, name: option.name, priceDeltaCents: option.priceDeltaCents })),
      ),
    [product.optionGroups, selections],
  )
  const unitTotal = basePrice + selectedOptions.reduce((sum, option) => sum + option.priceDeltaCents, 0)

  function toggle(groupId: string, optionId: string, maxSelect: number) {
    setSelections((current) => {
      const values = current[groupId] ?? []
      if (values.includes(optionId)) return { ...current, [groupId]: values.filter((id) => id !== optionId) }
      if (maxSelect === 1) return { ...current, [groupId]: [optionId] }
      return { ...current, [groupId]: [...values, optionId].slice(-maxSelect) }
    })
  }

  function add() {
    if (selectedOptions.length > 30) {
      setError('El producto admite hasta 30 opciones seleccionadas.')
      return
    }
    for (const group of product.optionGroups) {
      const selectedCount = selections[group.id]?.length ?? 0
      if (selectedCount < group.minSelect || selectedCount > group.maxSelect) {
        setError(`${group.name}: elegí entre ${group.minSelect} y ${group.maxSelect}.`)
        return
      }
    }
    onAdd({
      key: crypto.randomUUID(),
      productId: product.id,
      productName: product.name,
      productImagePath: product.imagePath,
      quantity,
      notes: notes.trim(),
      unitPriceCents: basePrice,
      selectedOptions,
    })
    dialogRef.current?.close()
  }

  const imageUrl = publicAssetUrl(product.imagePath)
  return (
    <dialog ref={dialogRef} className="product-dialog" onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current?.close() }}>
      <div className="relative max-h-[92vh] overflow-y-auto rounded-t-[2rem] bg-white sm:rounded-[2rem]">
        <button className="absolute right-4 top-4 z-10 grid h-11 w-11 place-items-center rounded-full bg-white/90 shadow" onClick={() => dialogRef.current?.close()} aria-label="Cerrar"><X aria-hidden /></button>
        {imageUrl ? <img src={imageUrl} className="aspect-[16/10] w-full object-cover" alt={product.name} /> : <div className="grid aspect-[16/8] place-items-center bg-orange-50 text-5xl" role="img" aria-label="Sin imagen">🍽️</div>}
        <div className="p-5 sm:p-7">
          <h2 className="font-display text-2xl font-bold">{product.name}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">{product.description}</p>
          <p className="mt-4 text-xl font-bold">{formatMoney(basePrice, restaurant.currencyCode, restaurant.locale)}</p>
          <div className="mt-6 space-y-6">
            {product.optionGroups.map((group) => (
              <fieldset key={group.id}>
                <legend className="font-semibold">{group.name} <span className="ml-1 text-xs font-normal text-stone-500">{group.required ? 'Obligatorio' : 'Opcional'} · {group.maxSelect === 1 ? 'Elegí una' : `Hasta ${group.maxSelect}`}</span></legend>
                <div className="mt-2 space-y-2">{group.options.map((option) => <label key={option.id} className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 hover:bg-stone-50"><span className="flex items-center gap-3"><input type={group.maxSelect === 1 ? 'radio' : 'checkbox'} name={group.id} checked={selections[group.id]?.includes(option.id) ?? false} onChange={() => toggle(group.id, option.id, group.maxSelect)} />{option.name}</span>{option.priceDeltaCents !== 0 ? <span className="text-sm font-semibold">+ {formatMoney(option.priceDeltaCents, restaurant.currencyCode, restaurant.locale)}</span> : null}</label>)}</div>
              </fieldset>
            ))}
            <label className="field"><span>Observaciones para este producto</span><textarea maxLength={300} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Ej.: sin cebolla" /></label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <div className="flex items-center justify-between gap-4"><div className="flex items-center rounded-xl border border-stone-300"><button className="quantity-button" aria-label="Restar uno" onClick={() => setQuantity((value) => Math.max(1, value - 1))}><Minus aria-hidden /></button><span className="w-10 text-center font-bold" aria-live="polite">{quantity}</span><button className="quantity-button" aria-label="Sumar uno" onClick={() => setQuantity((value) => Math.min(20, value + 1))}><Plus aria-hidden /></button></div><button className="button-primary flex-1" onClick={add}>Agregar · {formatMoney(unitTotal * quantity, restaurant.currencyCode, restaurant.locale)}</button></div>
          </div>
        </div>
      </div>
    </dialog>
  )
}
