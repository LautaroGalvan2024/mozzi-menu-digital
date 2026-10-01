import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { z } from 'zod'
import { currentProductPrice } from '../../lib/money'
import { calculateCartLineTotal, cartLineConfigurationKey } from '../../lib/quantity-pricing'
import type { CartLine, PublicProduct } from '../../types/domain'

const MAX_CART_LINE_QUANTITY = 100

const cartQuantityPricesSchema = z.array(z.object({
  quantity: z.number().int().min(2).max(20),
  totalPriceCents: z.number().int().min(0).max(1_000_000_000_000),
})).max(19).superRefine((rules, context) => {
  const seen = new Set<number>()
  rules.forEach((rule, index) => {
    if (seen.has(rule.quantity)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [index, 'quantity'],
      message: 'Cantidad repetida.',
    })
    seen.add(rule.quantity)
  })
})

const lineSchema = z.object({
  key: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string().max(160),
  productImagePath: z.string().max(1_024).nullable(),
  quantity: z.number().int().min(1).max(MAX_CART_LINE_QUANTITY),
  notes: z.string().max(300),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000_000),
  quantityPrices: cartQuantityPricesSchema.default([]),
  selectedOptions: z.array(
    z.object({
      id: z.string().uuid(),
      groupName: z.string().max(120),
      name: z.string().max(120),
      priceDeltaCents: z.number().int().min(0).max(1_000_000_000_000),
    }),
  ).max(30),
})

interface CartContextValue {
  restaurantSlug: string | null
  lines: CartLine[]
  itemCount: number
  subtotalCents: number
  activateRestaurant: (slug: string) => void
  reconcileProducts: (products: readonly PublicProduct[]) => void
  addLine: (line: CartLine) => void
  updateQuantity: (key: string, quantity: number) => void
  removeLine: (key: string) => void
  clear: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

function storageKey(slug: string) {
  return `mozzi:cart:${slug}`
}

export function parseStoredCart(value: string | null): CartLine[] {
  if (!value) return []
  try {
    const parsed = z.array(lineSchema).safeParse(JSON.parse(value))
    return parsed.success ? normalizeCartLines(parsed.data) : []
  } catch {
    return []
  }
}

function readCart(slug: string): CartLine[] {
  try {
    return parseStoredCart(localStorage.getItem(storageKey(slug)))
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
      productName: product.name,
      productImagePath: product.imagePath,
      unitPriceCents: currentProductPrice(product),
      quantityPrices: product.quantityPrices,
      selectedOptions: line.selectedOptions.map((option) => optionById.get(option.id) ?? option),
    }
  }))
}

export function CartProvider({ children }: PropsWithChildren) {
  const [restaurantSlug, setRestaurantSlug] = useState<string | null>(null)
  const [lines, setLines] = useState<CartLine[]>([])

  const persist = useCallback(
    (next: CartLine[]) => {
      setLines(next)
      if (restaurantSlug) {
        try {
          localStorage.setItem(storageKey(restaurantSlug), JSON.stringify(next))
        } catch {
          // Keep the in-memory cart usable when storage is disabled or full.
        }
      }
    },
    [restaurantSlug],
  )

  const reconcileProducts = useCallback((products: readonly PublicProduct[]) => {
    setLines((current) => {
      const next = reconcileCartLines(current, products)
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      if (restaurantSlug) {
        try {
          localStorage.setItem(storageKey(restaurantSlug), JSON.stringify(next))
        } catch {
          // Keep the in-memory cart usable when storage is disabled or full.
        }
      }
      return next
    })
  }, [restaurantSlug])

  const value = useMemo<CartContextValue>(
    () => ({
      restaurantSlug,
      lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotalCents: lines.reduce(
        (sum, line) => sum + calculateCartLineTotal(line),
        0,
      ),
      activateRestaurant: (slug) => {
        if (slug === restaurantSlug) return
        setRestaurantSlug(slug)
        setLines(readCart(slug))
      },
      reconcileProducts,
      addLine: (line) => persist(addOrMergeCartLine(lines, line)),
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
    [lines, persist, reconcileProducts, restaurantSlug],
  )
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const value = useContext(CartContext)
  if (!value) throw new Error('useCart requiere CartProvider')
  return value
}
