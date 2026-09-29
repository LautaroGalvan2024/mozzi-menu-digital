import { CheckCircle2, Clipboard, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { ErrorPanel } from '../../components/Feedback'
import { formatMoney } from '../../lib/money'
import { whatsappWebUrl } from '../../lib/phone'
import { supabase } from '../../lib/supabase/client'
import { generatedOrderSchema } from '../../lib/validation/schemas'
import { useCart } from '../cart/CartProvider'

export function OrderGeneratedPage() {
  const { restaurantSlug } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const cart = useCart()
  const cartCleared = useRef(false)
  const [generated] = useState(() => {
    const parsed = generatedOrderSchema.safeParse(location.state)
    return parsed.success ? parsed.data : null
  })
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (!generated || cartCleared.current) return
    cartCleared.current = true
    cart.clear()
  }, [cart, generated])

  useEffect(() => {
    if (generated && location.state !== null) {
      void navigate(location.pathname, { replace: true, state: null })
    }
  }, [generated, location.pathname, location.state, navigate])

  if (!generated) return <main className="page-shell py-16"><ErrorPanel title="Esta confirmación ya no está disponible">Por privacidad no guardamos el mensaje completo en el navegador. Revisá WhatsApp o consultá al comercio.<div className="mt-4"><Link className="button-primary" to={`/r/${restaurantSlug}`}>Volver al menú</Link></div></ErrorPanel></main>
  const orderResult = generated
  const stillPending = ['generated', 'whatsapp_opened'].includes(orderResult.order.status)
  const webUrl = whatsappWebUrl(orderResult.whatsapp.url, orderResult.whatsapp.message)

  async function registerWhatsappOpened() {
    if (!orderResult.clientEventToken) return
    try {
      await Promise.race([
        supabase.functions.invoke('register-whatsapp-opened', { body: { actionId: orderResult.order.actionId, clientEventToken: orderResult.clientEventToken } }),
        new Promise((resolve) => window.setTimeout(resolve, 1800)),
      ])
    } catch {
      // La telemetría no debe impedir que el cliente continúe a WhatsApp.
    }
  }

  async function openWhatsapp() {
    if (opening) return
    setOpening(true)
    await registerWhatsappOpened()
    window.location.assign(orderResult.whatsapp.url)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(orderResult.whatsapp.message)
      setCopied(true)
      setCopyError(false)
    } catch {
      setCopied(false)
      setCopyError(true)
    }
  }

  return <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,#ffe2d3,transparent_45%),#f7f4ef] p-4"><section className="w-full max-w-xl rounded-[2rem] bg-white p-6 text-center shadow-2xl shadow-stone-900/10 sm:p-9"><CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" aria-hidden /><p className="mt-5 text-xs font-bold uppercase tracking-[.2em] text-orange-700">{stillPending?'Pedido generado':'Pedido recuperado'}</p><h1 className="mt-2 font-display text-4xl font-bold">{orderResult.order.displayNumber}</h1><p className="mt-3 text-lg font-bold">{formatMoney(orderResult.order.totalCents, orderResult.order.currencyCode)}</p><p className="mx-auto mt-4 max-w-md text-sm leading-6 text-stone-600">{stillPending?'Todavía falta enviarlo por WhatsApp. Luego, el comercio debe aceptarlo para que quede confirmado.':`Este pedido ya está en estado ${orderResult.order.status}. La clave de idempotencia evitó crear un duplicado.`}</p><div className="mt-7 grid gap-3">{stillPending?<div className="grid gap-3 sm:grid-cols-2"><button className="button-primary min-h-14" disabled={opening} onClick={() => void openWhatsapp()}>{opening ? 'Abriendo WhatsApp…' : <><ExternalLink className="h-5 w-5" aria-hidden />Abrir WhatsApp</>}</button><a className="button-secondary min-h-14" href={webUrl} target="_blank" rel="noopener noreferrer" onClick={() => void registerWhatsappOpened()}><ExternalLink className="h-5 w-5" aria-hidden />Abrir WhatsApp Web</a></div>:null}<button className="button-secondary" onClick={() => void copy()}><Clipboard className="h-4 w-4" aria-hidden />{copied ? 'Mensaje copiado' : 'Copiar mensaje'}</button>{copyError ? <p className="form-error" role="alert">No pudimos copiar el mensaje. Abrí WhatsApp para continuar.</p> : null}<Link className="mt-2 text-sm font-semibold text-stone-600 underline" to={`/r/${restaurantSlug}`}>Volver al menú</Link></div></section></main>
}
