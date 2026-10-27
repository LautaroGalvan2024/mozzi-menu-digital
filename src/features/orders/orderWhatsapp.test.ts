import { describe, expect, it } from 'vitest'
import { orderContactPhone, orderWhatsappContact } from './orderWhatsapp'

const order = {
  customer_name: 'Lucía & Tomás',
  customer_phone: '+54 9 (3492) 123-456',
  display_number: 'PED-0010',
  status: 'generated' as const,
  checkout_mode: 'online' as const,
  payment_status: 'approved',
  inventory_outcome: 'none' as const,
}

describe('customer WhatsApp contact', () => {
  it('encodes a personal preparation message with the business and order number', () => {
    const contact = orderWhatsappContact(order, 'Fundas + Más & Co')!
    const url = new URL(contact.url)
    expect(url.origin).toBe('https://wa.me')
    expect(url.pathname).toBe('/5493492123456')
    expect(url.searchParams.get('text')).toBe('Hola, Lucía & Tomás. Somos Fundas + Más & Co. Recibimos tu pedido PED-0010 y lo estamos preparando. ¡Gracias por tu compra!')
    expect(url.search).toContain('%26')
    expect(url.searchParams.size).toBe(1)
    expect(contact.preparing).toBe(true)
  })

  it('normalizes international formatting without accepting arbitrary characters or invalid lengths', () => {
    expect(orderContactPhone('0054 9 (3492) 123-456')).toBe('+5493492123456')
    expect(orderContactPhone('5493492123456')).toBe('+5493492123456')
    for (const phone of ['', '+0123456789', '+12345', '+1234567890123456', '+549abc3492123456', 'https://wa.me/5493492123456', '+5493492123456 ext 2', '++5493492123456']) {
      expect(orderContactPhone(phone)).toBeNull()
      expect(orderWhatsappContact({ ...order, customer_phone: phone })).toBeNull()
    }
  })

  it.each(['unpaid', 'pending', 'in_process', 'authorized', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'charged_back', 'requires_refund', 'expired', 'in_mediation', 'unknown'])('does not claim preparation for online payment %s', (payment_status) => {
    const contact = orderWhatsappContact({ ...order, payment_status }, 'Fundas')!
    expect(contact.preparing).toBe(false)
    expect(contact.message).toBe('Hola, Lucía & Tomás. Somos Fundas. Te escribimos por tu pedido PED-0010.')
  })

  it.each(['completed', 'cancelled', 'expired'] as const)('does not claim preparation for an order %s even if paid', (status) => {
    expect(orderWhatsappContact({ ...order, status })?.preparing).toBe(false)
  })

  it.each(['generated', 'whatsapp_opened', 'accepted'] as const)('supports active WhatsApp orders %s without changing their state', (status) => {
    const input = { ...order, checkout_mode: 'whatsapp' as const, payment_status: 'unpaid', status }
    expect(orderWhatsappContact(input)?.preparing).toBe(true)
    expect(input.status).toBe(status)
  })

  it('keeps reversed inventory messages neutral and handles missing display names', () => {
    expect(orderWhatsappContact({ ...order, inventory_outcome: 'returned' })?.preparing).toBe(false)
    expect(orderWhatsappContact({ ...order, inventory_outcome: 'corrected' })?.preparing).toBe(false)
    expect(orderWhatsappContact({ ...order, customer_name: '', display_number: '' })?.message).toBe('Hola. Recibimos tu pedido y lo estamos preparando. ¡Gracias por tu compra!')
  })
})
