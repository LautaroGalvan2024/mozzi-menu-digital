import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useLocation, useParams, useSearchParams } from 'react-router'
import { z } from 'zod'
import { commerceStorageKey, useCommerceChannel } from '../../lib/commerce-channel'
import { publicAssetUrl } from '../../lib/supabase/public-assets'

const publicSellerSchema = z.object({ id: z.string().uuid(), name: z.string(), imagePath: z.string().nullable() })
const sellerIdSchema = z.string().uuid()
type SellerReferral = { seller: z.infer<typeof publicSellerSchema> | null; checking: boolean; clear: () => void }
const SellerContext = createContext<SellerReferral>({ seller: null, checking: false, clear: () => {} })

/** A public referral is browser-scoped; the server resolves it again when creating an order. */
export class SellerReferralCode {
  static parse(value: string | null): string | undefined {
    const result = sellerIdSchema.safeParse(value)
    return result.success ? result.data : undefined
  }

  static read(key: string): string | undefined {
    try { return this.parse(sessionStorage.getItem(key)) } catch { return undefined }
  }
}

export function SellerReferralProvider({ children }: { children: ReactNode }) {
  const { restaurantSlug = '' } = useParams()
  const { search } = useLocation()
  const [, setSearchParams] = useSearchParams()
  const channel = useCommerceChannel()
  const key = commerceStorageKey('seller-referral', restaurantSlug, channel)
  const requestedId = SellerReferralCode.parse(new URLSearchParams(search).get('vendedor'))
  const sellerId = requestedId ?? SellerReferralCode.read(key)
  useEffect(() => {
    if (!requestedId) return
    try { sessionStorage.setItem(key, requestedId) } catch { /* Links still resolve on their original page. */ }
  }, [key, requestedId])

  const query = useQuery({
    queryKey: ['public-seller', restaurantSlug, channel, sellerId],
    enabled: Boolean(restaurantSlug && sellerId),
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const { supabase } = await import('../../lib/supabase/client')
      const result = await supabase.rpc('get_public_seller', {
        p_restaurant_slug: restaurantSlug, p_channel: channel, p_seller_id: sellerId!,
      }).abortSignal(signal)
      if (result.error) throw new Error('No se pudo verificar el vendedor.')
      return publicSellerSchema.nullable().parse(result.data)
    },
  })
  function clear() {
    try { sessionStorage.removeItem(key) } catch { /* The original URL can still be cleared. */ }
    if (requestedId) setSearchParams(current => {
      const next = new URLSearchParams(current)
      next.delete('vendedor')
      return next
    }, { replace: true })
    else setSearchParams(new URLSearchParams(search), { replace: true })
  }

  return <SellerContext.Provider value={{ seller: query.data ?? null, checking: Boolean(sellerId && (query.isLoading || query.isError)), clear }}>
    {query.isError ? <p className="p-2 text-center text-sm" role="status">No se pudo confirmar el vendedor. <button type="button" className="underline" onClick={() => void query.refetch()}>Reintentar</button> · <button type="button" className="underline" onClick={clear}>Continuar con el comercio</button></p> : null}
    {sellerId && query.isSuccess && query.data === null ? <p className="p-2 text-center text-sm" role="status">Ese vendedor ya no está disponible. Podés comprar directamente al comercio.</p> : null}
    {children}
  </SellerContext.Provider>
}

export function useSellerReferral() { return useContext(SellerContext) }

export function SellerReferralBanner() {
  const { seller } = useSellerReferral()
  const { pathname } = useLocation()
  if (!seller || /\/(checkout|pedido-generado|pago)$/.test(pathname)) return null
  const photo = publicAssetUrl(seller.imagePath)
  return <div className="flex items-center justify-center gap-2 bg-stone-50 px-4 py-2 text-sm text-stone-800">
    {photo ? <img className="h-8 w-8 rounded-full object-cover" src={photo} alt="" /> : null}
    <p>Te atiende <strong>{seller.name}</strong></p>
  </div>
}
