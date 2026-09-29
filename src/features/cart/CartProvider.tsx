import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { z } from 'zod'
import type { CartLine } from '../../types/domain'

const lineSchema = z.object({
  key: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string().max(160),
  productImagePath: z.string().max(1_024).nullable(),
  quantity: z.number().int().min(1).max(20),
  notes: z.string().max(300),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000_000),
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
  addLine: (line: CartLine) => void
  updateQuantity: (key: string, quantity: number) => void
  removeLine: (key: string) => void
  clear: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

function storageKey(slug: string) {
  return `mozzi:cart:${slug}`
}

function readCart(slug: string): CartLine[] {
  try {
    const value = localStorage.getItem(storageKey(slug))
    if (!value) return []
    const parsed = z.array(lineSchema).safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
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

  const value = useMemo<CartContextValue>(
    () => ({
      restaurantSlug,
      lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotalCents: lines.reduce(
        (sum, line) =>
          sum +
          (line.unitPriceCents +
            line.selectedOptions.reduce((optionSum, option) => optionSum + option.priceDeltaCents, 0)) *
            line.quantity,
        0,
      ),
      activateRestaurant: (slug) => {
        if (slug === restaurantSlug) return
        setRestaurantSlug(slug)
        setLines(readCart(slug))
      },
      addLine: (line) => persist([...lines, line]),
      updateQuantity: (key, quantity) => {
        if (quantity < 1) persist(lines.filter((line) => line.key !== key))
        else persist(lines.map((line) => (line.key === key ? { ...line, quantity: Math.min(20, quantity) } : line)))
      },
      removeLine: (key) => persist(lines.filter((line) => line.key !== key)),
      clear: () => persist([]),
    }),
    [lines, persist, restaurantSlug],
  )
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const value = useContext(CartContext)
  if (!value) throw new Error('useCart requiere CartProvider')
  return value
}
