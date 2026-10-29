import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { currentProductPrice } from '../../lib/money'
import { calculateCartLineTotal, cartLineConfigurationKey } from '../../lib/quantity-pricing'
import type { CartLine, PublicProduct } from '../../types/domain'
import { commerceStorageKey, type CommerceChannel } from '../../lib/commerce-channel'
import { cartProductName } from '../../lib/catalog-presentation'

const MAX_CART_LINE_QUANTITY = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_MONEY_CENTS = 1_000_000_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validMoney(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_MONEY_CENTS
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function parseCartLine(value: unknown): CartLine | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !UUID.test(value.key) || typeof value.productId !== 'string' || !UUID.test(value.productId)) return null
  if (!validText(value.productName, 160) || !(value.productImagePath === null || validText(value.productImagePath, 1_024))) return null
  if (!Number.isInteger(value.quantity) || Number(value.quantity) < 1 || Number(value.quantity) > MAX_CART_LINE_QUANTITY || !validText(value.notes, 300) || !validMoney(value.unitPriceCents)) return null

  const rawPrices = value.quantityPrices === undefined ? [] : value.quantityPrices
  if (!Array.isArray(rawPrices) || rawPrices.length > 19) return null
  const seenQuantities = new Set<number>()
  const quantityPrices: CartLine['quantityPrices'] = []
  for (const price of rawPrices) {
    if (!isRecord(price) || !Number.isInteger(price.quantity) || Number(price.quantity) < 2 || Number(price.quantity) > 20 || !validMoney(price.totalPriceCents) || seenQuantities.has(Number(price.quantity))) return null
    seenQuantities.add(Number(price.quantity))
    quantityPrices.push({ quantity: Number(price.quantity), totalPriceCents: Number(price.totalPriceCents) })
  }

  if (!Array.isArray(value.selectedOptions) || value.selectedOptions.length > 30) return null
  const selectedOptions: CartLine['selectedOptions'] = []
  for (const option of value.selectedOptions) {
    if (!isRecord(option) || typeof option.id !== 'string' || !UUID.test(option.id) || !validText(option.groupName, 120) || !validText(option.name, 120) || !validMoney(option.priceDeltaCents)) return null
    selectedOptions.push({
      id: option.id,
      groupName: option.groupName,
      name: option.name,
      priceDeltaCents: Number(option.priceDeltaCents),
    })
  }

  return {
    key: value.key,
    productId: value.productId,
    productName: value.productName,
    productImagePath: value.productImagePath,
    quantity: Number(value.quantity),
    notes: value.notes,
    unitPriceCents: Number(value.unitPriceCents),
    quantityPrices,
    selectedOptions,
  }
}

interface CartContextValue {
  channel: CommerceChannel
  restaurantSlug: string | null
  lines: CartLine[]
  itemCount: number
  subtotalCents: number
  activateRestaurant: (slug: string, channel?: CommerceChannel) => void
  reconcileProducts: (products: readonly PublicProduct[]) => void
  addLine: (line: CartLine) => void
  replaceLine: (key: string, line: CartLine) => void
  updateQuantity: (key: string, quantity: number) => void
  removeLine: (key: string) => void
  clear: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

function storageKey(slug: string, channel: CommerceChannel = 'menu') {
  return commerceStorageKey('cart', slug, channel)
}

export function parseStoredCart(value: string | null): CartLine[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    const lines = parsed.map(parseCartLine)
    return lines.every((line): line is CartLine => line !== null) ? normalizeCartLines(lines) : []
  } catch {
    return []
  }
}

function readCart(slug: string, channel: CommerceChannel): CartLine[] {
  try {
    return parseStoredCart(localStorage.getItem(storageKey(slug, channel)))
  } catch {
    return []
  }
}

/**
 * Coalesces equal configurations independently of how they were added. Valid
 * carts (at most 100 units total) end up with one canonical line, so quantity
 * pricing cannot change because an older client persisted `[1, 1]` instead of
 * `[2]`. Extra chunks only keep an already-invalid (>100 units) cart editable.
 */
export function normalizeCartLines(lines: readonly CartLine[]): CartLine[] {
  const groups = new Map<string, { firstIndex: number; lines: CartLine[] }>()
  lines.forEach((line, index) => {
    const configuration = cartLineConfigurationKey(line)
    const current = groups.get(configuration)
    if (current) current.lines.push(line)
    else groups.set(configuration, { firstIndex: index, lines: [line] })
  })

  const replacements = new Map<number, CartLine[]>()
  for (const group of groups.values()) {
    const totalQuantity = group.lines.reduce((total, line) => total + line.quantity, 0)
    const template = group.lines.at(-1)!
    const keys = group.lines.map((line) => line.key)
    const normalized: CartLine[] = []
    let remaining = totalQuantity
    let chunkIndex = 0
    while (remaining > 0) {
      const quantity = Math.min(MAX_CART_LINE_QUANTITY, remaining)
      normalized.push({
        ...template,
        key: keys[chunkIndex] ?? crypto.randomUUID(),
        notes: template.notes.trim(),
        quantity,
      })
      remaining -= quantity
      chunkIndex += 1
    }
    replacements.set(group.firstIndex, normalized)
  }

  return lines.flatMap((line, index) => {
    const group = groups.get(cartLineConfigurationKey(line))!
    return group.firstIndex === index ? replacements.get(index)! : []
  })
}

export function addOrMergeCartLine(lines: readonly CartLine[], incoming: CartLine): CartLine[] {
  return normalizeCartLines([...lines, { ...incoming, notes: incoming.notes.trim() }])
}

export function reconcileCartLines(
  lines: readonly CartLine[],
  products: readonly PublicProduct[],
): CartLine[] {
  const productById = new Map(products.map((product) => [product.id, product]))
  return normalizeCartLines(lines.map((line) => {
    const product = productById.get(line.productId)
    if (!product) return line
    const optionById = new Map(product.optionGroups.flatMap((group) =>
      group.options.map((option) => [option.id, {
        id: option.id,
        groupName: group.name,
        name: option.name,
        priceDeltaCents: option.priceDeltaCents,
      }] as const),
    ))
    return {
      ...line,
      productName: cartProductName(product),
      productImagePath: product.imagePath,
      unitPriceCents: currentProductPrice(product),
      quantityPrices: product.quantityPrices,
      selectedOptions: line.selectedOptions.map((option) => optionById.get(option.id) ?? option),
    }
  }))
}

export function CartProvider({ children }: PropsWithChildren) {
  const [restaurantSlug, setRestaurantSlug] = useState<string | null>(null)
  const [channel, setChannel] = useState<CommerceChannel>('menu')
  const [lines, setLines] = useState<CartLine[]>([])

  const persist = useCallback(
    (next: CartLine[]) => {
      setLines(next)
      if (restaurantSlug) {
        try {
          localStorage.setItem(storageKey(restaurantSlug, channel), JSON.stringify(next))
        } catch {
          // Keep the in-memory cart usable when storage is disabled or full.
        }
      }
    },
    [restaurantSlug, channel],
  )

  const reconcileProducts = useCallback((products: readonly PublicProduct[]) => {
    setLines((current) => {
      const next = reconcileCartLines(current, products)
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      if (restaurantSlug) {
        try {
          localStorage.setItem(storageKey(restaurantSlug, channel), JSON.stringify(next))
        } catch {
          // Keep the in-memory cart usable when storage is disabled or full.
        }
      }
      return next
    })
  }, [restaurantSlug, channel])

  const value = useMemo<CartContextValue>(
    () => ({
      restaurantSlug,
      channel,
      lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotalCents: lines.reduce(
        (sum, line) => sum + calculateCartLineTotal(line),
        0,
      ),
      activateRestaurant: (slug, nextChannel = 'menu') => {
        if (slug === restaurantSlug && nextChannel === channel) return
        setRestaurantSlug(slug)
        setChannel(nextChannel)
        setLines(readCart(slug, nextChannel))
      },
      reconcileProducts,
      addLine: (line) => persist(addOrMergeCartLine(lines, line)),
      replaceLine: (key, replacement) => persist(normalizeCartLines(lines.map(line => line.key === key ? { ...replacement, key } : line))),
      updateQuantity: (key, quantity) => {
        if (quantity < 1) persist(lines.filter((line) => line.key !== key))
        else persist(normalizeCartLines(lines.map((line) => (
          line.key === key
            ? { ...line, quantity: Math.min(MAX_CART_LINE_QUANTITY, quantity) }
            : line
        ))))
      },
      removeLine: (key) => persist(lines.filter((line) => line.key !== key)),
      clear: () => persist([]),
    }),
    [lines, persist, reconcileProducts, restaurantSlug, channel],
  )
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const value = useContext(CartContext)
  if (!value) throw new Error('useCart requiere CartProvider')
  return value
}
