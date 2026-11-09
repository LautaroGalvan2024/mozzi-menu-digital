import { Check, Minus, Package, Plus, Search, X } from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { cartProductName, variantLabel } from '../../lib/catalog-presentation'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { currentProductPrice, formatMoney } from '../../lib/money'
import { calculateQuantityPricing, effectiveQuantityPrices } from '../../lib/quantity-pricing'
import type { CartLine, PublicCatalogGroup, PublicProduct, PublicRestaurant } from '../../types/domain'

const FALLBACK_STORE_TIME = new Date(0)
export const StoreServerTimeContext = createContext<Date>(FALLBACK_STORE_TIME)

export function useStoreServerTime() {
  return useContext(StoreServerTimeContext)
}

export function StoreProductMedia({
  product,
  familyImagePath = null,
  detail = false,
}: {
  product: PublicProduct
  familyImagePath?: string | null
  detail?: boolean
}) {
  const path = detail ? product.imagePath ?? familyImagePath : familyImagePath ?? product.imagePath
  const image = responsiveAssetUrls(path)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const close = () => dialog.removeAttribute('data-visible')
    dialog.addEventListener('close', close)
    return () => dialog.removeEventListener('close', close)
  }, [])

  if (!image.src) {
    return <div className="store-image-placeholder" aria-label="Producto sin foto" role="img"><Package aria-hidden /></div>
  }

  const picture = <img
    src={image.src}
    srcSet={image.srcSet}
    sizes={detail ? '(min-width: 900px) 520px, calc(100vw - 2rem)' : '(min-width: 1024px) 260px, (min-width: 640px) 33vw, 50vw'}
    alt={detail ? product.family?.name ?? product.name : ''}
    loading={detail ? 'eager' : 'lazy'}
    decoding="async"
  />

  if (!detail) return picture

  return <>
    <button
      type="button"
      className="store-detail-image-button"
      onClick={() => { dialogRef.current?.setAttribute('data-visible', ''); dialogRef.current?.showModal() }}
      aria-label={`Ampliar foto de ${product.family?.name ?? product.name}`}
    >
      {picture}<span><Search aria-hidden />Ampliar</span>
    </button>
    <dialog ref={dialogRef} className="store-image-dialog" aria-label={`Foto ampliada de ${product.family?.name ?? product.name}`}>
      <button type="button" onClick={() => dialogRef.current?.close()} aria-label="Cerrar foto"><X aria-hidden /></button>
      <img src={image.src} srcSet={image.srcSet} sizes="100vw" alt={product.family?.name ?? product.name} />
    </dialog>
  </>
}

function firstPurchasable(variants: PublicProduct[]) {
  return variants.find(variant => variant.available) ?? variants[0]!
}

export function purchasablePrice(group: PublicCatalogGroup, now: Date) {
  const purchasable = group.variants.filter(variant => variant.available)
  const candidates = purchasable.length ? purchasable : group.variants
  return Math.min(...candidates.map(variant => currentProductPrice(variant, now)))
}

export function productBenefit(product: PublicProduct, restaurant: PublicRestaurant, now: Date) {
  const price = currentProductPrice(product, now)
  if (price < product.basePriceCents) {
    const percentage = Math.max(1, Math.round((1 - price / product.basePriceCents) * 100))
    return { label: `${percentage}% menos`, detail: `Antes ${formatMoney(product.basePriceCents, restaurant.currencyCode, restaurant.locale)}`, kind: 'promotion' as const }
  }
  if (product.quantityThreshold && product.quantityThreshold.unitPriceCents < price) {
    return { label: `Desde ${product.quantityThreshold.minimumQuantity} unidades`, detail: `${formatMoney(product.quantityThreshold.unitPriceCents, restaurant.currencyCode, restaurant.locale)} c/u`, kind: 'quantity' as const }
  }
  const pack = effectiveQuantityPrices(price, product.quantityPrices)[0]
  if (pack) return { label: `${pack.quantity} unidades`, detail: formatMoney(pack.totalPriceCents, restaurant.currencyCode, restaurant.locale), kind: 'quantity' as const }
  return null
}

export function StoreProductConfigurator({
  group,
  restaurant,
  acceptsOrders,
  initialProductId,
  onAdd,
}: {
  group: PublicCatalogGroup
  restaurant: PublicRestaurant
  acceptsOrders: boolean
  initialProductId?: string | undefined
  onAdd: (line: CartLine) => void
}) {
  const now = useStoreServerTime()
  const variants = group.variants
  const initialVariant = variants.find(variant => variant.id === initialProductId && variant.available) ?? firstPurchasable(variants)
  const [selectedId, setSelectedId] = useState(() => initialVariant.id)
  const selected = variants.find(variant => variant.id === selectedId) ?? firstPurchasable(variants)
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState('')
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedId(initialVariant.id)
  }, [group.id, initialProductId, initialVariant.id])

  useEffect(() => {
    setSelections(Object.fromEntries(selected.optionGroups.map(group => [group.id, []])))
    setError(null)
    setQuantity(1)
  }, [selected.id, selected.optionGroups])

  const selectedOptions = useMemo(() => selected.optionGroups.flatMap(optionGroup =>
    optionGroup.options
      .filter(option => selections[optionGroup.id]?.includes(option.id))
      .map(option => ({ id: option.id, groupName: optionGroup.name, name: option.name, priceDeltaCents: option.priceDeltaCents })),
  ), [selected.optionGroups, selections])
  const optionUnitCents = selectedOptions.reduce((total, option) => total + option.priceDeltaCents, 0)
  const unitPriceCents = currentProductPrice(selected, now)
  const pricing = calculateQuantityPricing({
    quantity,
    unitPriceCents,
    quantityPrices: selected.quantityPrices,
    quantityThreshold: selected.quantityThreshold ?? null,
    optionUnitCents,
  })
  const benefit = productBenefit(selected, restaurant, now)
  const money = (amount: number) => formatMoney(amount, restaurant.currencyCode, restaurant.locale)

  function variantsForAxisValue(axis: string, value: string) {
    const axes = group.family?.axes ?? []
    const axisIndex = axes.indexOf(axis)
    const lockedAxes = axisIndex > 0 ? axes.slice(0, axisIndex) : []
    return variants.filter(variant =>
      variant.variantAttributes?.[axis] === value &&
      lockedAxes.every(locked => variant.variantAttributes?.[locked] === selected.variantAttributes?.[locked]),
    )
  }

  function chooseAxis(axis: string, value: string) {
    const candidates = variantsForAxisValue(axis, value)
    const otherAxes = group.family?.axes.filter(candidate => candidate !== axis) ?? []
    const exact = candidates.find(variant => otherAxes.every(candidate =>
      !selected.variantAttributes?.[candidate] || variant.variantAttributes?.[candidate] === selected.variantAttributes?.[candidate],
    ))
    const next = (exact?.available ? exact : candidates.find(variant => variant.available))
    if (next) setSelectedId(next.id)
  }

  function toggleOption(groupId: string, optionId: string, maxSelect: number) {
    const values = selections[groupId] ?? []
    if (values.includes(optionId)) {
      setSelections(current => ({ ...current, [groupId]: values.filter(id => id !== optionId) }))
      setError(null)
      return
    }
    if (maxSelect === 1) {
      setSelections(current => ({ ...current, [groupId]: [optionId] }))
      setError(null)
      return
    }
    if (values.length >= maxSelect) {
      setError('Quitá una opción antes de agregar otra en este grupo.')
      return
    }
    setSelections(current => ({ ...current, [groupId]: [...values, optionId] }))
    setError(null)
  }

  function add() {
    if (!selected.available || !acceptsOrders) return
    for (const optionGroup of selected.optionGroups) {
      const count = selections[optionGroup.id]?.length ?? 0
      if (count < optionGroup.minSelect || count > optionGroup.maxSelect) {
        setError(`${optionGroup.name}: elegí entre ${optionGroup.minSelect} y ${optionGroup.maxSelect}.`)
        return
      }
    }
    onAdd({
      key: crypto.randomUUID(),
      productId: selected.id,
      productName: cartProductName(selected),
      productImagePath: selected.imagePath ?? group.family?.imagePath ?? null,
      quantity,
      notes: notes.trim(),
      unitPriceCents,
      quantityPrices: selected.quantityPrices,
      quantityThreshold: selected.quantityThreshold ?? null,
      selectedOptions,
    })
    setError(null)
  }

  return <div className="store-product-detail">
    <div className="store-detail-image"><StoreProductMedia product={selected} familyImagePath={group.family?.imagePath ?? null} detail /></div>
    <div className="store-detail-content">
      <p className="store-eyebrow">Producto</p>
      <h1 id="store-product-title">{group.family?.name ?? selected.name}</h1>
      <div className="store-detail-statuses">
        <span className={`store-availability ${selected.available ? '' : 'is-unavailable'}`}>{selected.available ? <Check aria-hidden /> : null}{selected.available ? 'Disponible' : 'Agotado'}</span>
        {!acceptsOrders ? <span className="store-order-status is-paused"><span aria-hidden />Pedidos pausados</span> : null}
      </div>
      <div className="store-detail-pricing">
        <p className="store-detail-price">{money(unitPriceCents)}</p>
        {benefit ? <div className={`store-benefit is-${benefit.kind}`}><strong>{benefit.label}</strong><span>{benefit.detail}</span></div> : null}
      </div>
      {(group.family?.description ?? selected.description) ? <p className="store-detail-description">{group.family?.description ?? selected.description}</p> : null}

      {group.family?.axes.map(axis => {
        const values = [...new Set(variants.map(variant => variant.variantAttributes?.[axis]).filter((value): value is string => Boolean(value)))]
        return <fieldset className="store-choice-group" key={axis}>
          <legend>{axis}<span>{selected.variantAttributes?.[axis]}</span></legend>
          <div className="store-choice-list">{values.map(value => {
            const candidates = variantsForAxisValue(axis, value)
            const available = candidates.some(variant => variant.available)
            const active = selected.variantAttributes?.[axis] === value
            return <button key={value} type="button" aria-pressed={active} className="store-choice" disabled={!available} onClick={() => chooseAxis(axis, value)}>{value}{!available ? <small>Agotado</small> : null}</button>
          })}</div>
        </fieldset>
      })}

      {group.family && !group.family.axes.length ? <label className="store-variant-select"><span>Elegí una variante</span><select value={selected.id} onChange={event => setSelectedId(event.target.value)}>{variants.map(variant => <option key={variant.id} value={variant.id}>{variantLabel(variant) || variant.name}{!variant.available ? ' · Agotado' : ''}</option>)}</select></label> : null}

      {selected.optionGroups.map(optionGroup => <fieldset className="store-option-group" key={optionGroup.id}>
        <legend>{optionGroup.name}<span>{optionGroup.required ? 'Obligatorio' : 'Opcional'} · {optionGroup.maxSelect === 1 ? 'Elegí una opción' : `Hasta ${optionGroup.maxSelect}`}</span></legend>
        <div>{optionGroup.options.map(option => <label key={option.id}>
          <span><input type={optionGroup.maxSelect === 1 ? 'radio' : 'checkbox'} name={optionGroup.id} checked={selections[optionGroup.id]?.includes(option.id) ?? false} onChange={() => toggleOption(optionGroup.id, option.id, optionGroup.maxSelect)} />{option.name}</span>
          {option.priceDeltaCents ? <small>+ {money(option.priceDeltaCents)}</small> : null}
        </label>)}</div>
      </fieldset>)}

      <label className="store-notes"><span>¿Querés aclarar algo? <small>Opcional</small></span><textarea rows={2} maxLength={300} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Información para el comercio" /></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="store-detail-purchase">
        <div className="store-quantity" aria-label="Cantidad">
          <button type="button" onClick={() => setQuantity(value => Math.max(1, value - 1))} aria-label="Restar uno"><Minus aria-hidden /></button>
          <span aria-live="polite">{quantity}</span>
          <button type="button" onClick={() => setQuantity(value => Math.min(100, value + 1))} aria-label="Sumar uno"><Plus aria-hidden /></button>
        </div>
        <button type="button" className="store-add-primary" disabled={!selected.available || !acceptsOrders} onClick={add}><span>Agregar al carrito</span><strong>{money(pricing.totalCents)}</strong></button>
      </div>
      {!acceptsOrders ? <p className="store-purchase-help">El comercio tiene los pedidos pausados. Podés seguir explorando el catálogo.</p> : !selected.available ? <p className="store-purchase-help">Esta combinación no está disponible por el momento.</p> : null}
    </div>
  </div>
}
