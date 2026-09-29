export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Ingresá un teléfono válido, con código de área.')
  }
  return `+${digits}`
}

export function whatsappUrl(phone: string, message: string) {
  return `https://wa.me/${normalizePhone(phone).slice(1)}?text=${encodeURIComponent(message)}`
}

export function whatsappShareUrl(message: string) {
  const destination = new URL('https://wa.me/')
  destination.searchParams.set('text', message)
  return destination.toString()
}

export function whatsappWebUrl(validatedWhatsappUrl: string, message: string) {
  const source = new URL(validatedWhatsappUrl)
  if (source.origin !== 'https://wa.me' || !/^\/\d+$/.test(source.pathname)) {
    throw new Error('La URL de WhatsApp no es válida.')
  }

  const destination = new URL('https://web.whatsapp.com/send')
  destination.searchParams.set('phone', source.pathname.slice(1))
  destination.searchParams.set('text', message)
  return destination.toString()
}
