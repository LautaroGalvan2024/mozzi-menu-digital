import { WhatsAppIcon } from '../../components/WhatsAppIcon'
import { orderWhatsappContact } from './orderWhatsapp'
import type { AdminOrderRow } from './orderSchemas'

export function OrderWhatsAppAction({ order, businessName, showLabel = false }: {
  order: AdminOrderRow
  businessName?: string
  showLabel?: boolean
}) {
  const contact = orderWhatsappContact(order, businessName)
  if (!contact) return null
  const label = `Escribir a ${order.customer_name || 'el cliente'} por WhatsApp sobre ${order.display_number || 'su pedido'}`
  return <a
    href={contact.url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={label}
    title={label}
    className={showLabel ? 'button-secondary min-h-11 text-emerald-700 hover:bg-emerald-50' : 'icon-button text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800'}
  >
    <WhatsAppIcon className="h-5 w-5" />
    {showLabel ? 'WhatsApp al cliente' : null}
  </a>
}
