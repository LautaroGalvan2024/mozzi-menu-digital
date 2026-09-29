import { describe,expect,it } from 'vitest'
import { canTransition } from '../lib/orders'
import { normalizePhone,whatsappShareUrl,whatsappUrl,whatsappWebUrl } from '../lib/phone'
import { relativeReturnToSchema } from '../lib/validation/schemas'
import { validateImageFile } from '../lib/images/processImage'

describe('security helpers',()=>{
  it('normalizes WhatsApp phones and URL-encodes the message',()=>{expect(normalizePhone('+54 (9) 3492-123456')).toBe('+5493492123456');expect(whatsappUrl('+54 9 3492 123456','Hola & total $10')).toContain('Hola%20%26%20total%20%2410')})
  it('builds a WhatsApp share URL without a recipient',()=>{const result=new URL(whatsappShareUrl('Mirá el menú:\nhttps://menu.example.com/r/demo'));expect(result.origin).toBe('https://wa.me');expect(result.pathname).toBe('/');expect(result.searchParams.get('text')).toBe('Mirá el menú:\nhttps://menu.example.com/r/demo')})
  it('builds an explicit WhatsApp Web URL from the validated server destination',()=>{const result=new URL(whatsappWebUrl('https://wa.me/5493492123456?text=ignorado','Hola ñ\nTotal: $10'));expect(result.origin).toBe('https://web.whatsapp.com');expect(result.pathname).toBe('/send');expect(result.searchParams.get('phone')).toBe('5493492123456');expect(result.searchParams.get('text')).toBe('Hola ñ\nTotal: $10');expect(()=>whatsappWebUrl('https://example.com/5493492123456','Pedido')).toThrow(/no es válida/)})
  it('rejects open redirects',()=>{expect(relativeReturnToSchema.safeParse('/admin/pedidos').success).toBe(true);expect(relativeReturnToSchema.safeParse('//evil.example').success).toBe(false);expect(relativeReturnToSchema.safeParse('https://evil.example').success).toBe(false)})
  it('enforces order state transitions',()=>{expect(canTransition('generated','accepted')).toBe(true);expect(canTransition('completed','accepted')).toBe(false);expect(canTransition('cancelled','completed')).toBe(false)})
  it('rejects SVG before image decoding',()=>{const file=new File(['<svg/>'],'payload.svg',{type:'image/svg+xml'});expect(()=>validateImageFile(file)).toThrow(/SVG/)})
})
