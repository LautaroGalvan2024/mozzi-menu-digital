import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, type PDFFont, type PDFPage } from 'pdf-lib'
import QRCode from 'qrcode'
import { cartProductName } from '../../lib/catalog-presentation'
import { currentProductPrice, formatMoney } from '../../lib/money'
import { effectiveQuantityPrices } from '../../lib/quantity-pricing'
import { publicAssetUrl } from '../../lib/supabase/public-assets'
import { assetVariantPaths } from '../../lib/images/responsive'
import { downloadBlob } from '../../lib/download'
import { env } from '../../lib/env'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { campaignPath, productCampaignPath, type PublicCampaign } from './campaigns'

function encodable(value: string, font: PDFFont) {
  return [...value.replace(/\s+/g, ' ')].map(character => { try { font.encodeText(character); return character } catch { return '?' } }).join('')
}
export function wrapPdfText(value: string, font: PDFFont, size: number, width: number, maxLines: number) {
  const lines: string[] = []; let line = ''
  for (const word of encodable(value, font).trim().split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue }
    if (line) { lines.push(line); line = '' }
    for (const character of word) {
      if (font.widthOfTextAtSize(line + character, size) > width && line) { lines.push(line); line = '' }
      line += character
    }
  }
  if (line) lines.push(line.trim())
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = `${lines[maxLines - 1]!.slice(0, -3)}...` }
  return lines
}
function write(page: PDFPage, value: string, font: PDFFont, x: number, y: number, size: number, width: number, maxLines = 1) {
  wrapPdfText(value, font, size, width, maxLines).forEach((line, index) => page.drawText(line, { x, y: y - index * (size + 4), size, font, color: rgb(0.14, 0.15, 0.18) }))
}
async function imageBytes(path: string | null): Promise<ArrayBuffer | null> {
  const url = publicAssetUrl(path ? assetVariantPaths(path)[0] ?? path : null)
  if (!url) return null
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), credentials: 'omit' })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) return null
    const blob = await response.blob()
    if (blob.size > 1024 * 1024) return null
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas'); const ratio = Math.min(1, 500 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) { bitmap.close(); return null }
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close()
    return await new Promise<ArrayBuffer | null>(resolve => canvas.toBlob(output => { if (output) void output.arrayBuffer().then(resolve); else resolve(null) }, 'image/png'))
  } catch { return null }
}
export async function createCampaignPdf(data: PublicCampaign, channel: CommerceChannel, onProgress?: (current: number, total: number) => void) {
  if (data.expired) throw new Error('Esta revista ya finalizó. Abrí el catálogo para consultar precios actuales.')
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  pdf.setTitle(`${data.campaign.title} · ${data.restaurant.tradeName}`); pdf.setAuthor(data.restaurant.tradeName)
  const url = new URL(campaignPath(data.restaurant.slug, channel, data.campaign), `${env.appBaseUrl}/`).toString()
  const qr = await pdf.embedPng(await QRCode.toDataURL(url, { width: 200, margin: 1 }))
  const now = new Date(data.serverNow)
  const date = now.toLocaleString(data.restaurant.locale, { timeZone: data.restaurant.timezone })
  const money = (amount: number) => formatMoney(amount, data.restaurant.currencyCode, data.restaurant.locale)
  const brand = /^#[\da-f]{6}$/i.test(data.restaurant.primaryColor) ? data.restaurant.primaryColor : '#ff6d00'
  const brandColor = rgb(Number.parseInt(brand.slice(1, 3), 16) / 255, Number.parseInt(brand.slice(3, 5), 16) / 255, Number.parseInt(brand.slice(5, 7), 16) / 255)
  const logoBytes = await imageBytes(data.restaurant.logoPath)
  const logo = logoBytes ? await pdf.embedPng(logoBytes) : null
  const productImages: (ArrayBuffer | null)[] = []
  // Bounded concurrency keeps a long magazine responsive without requesting every image at once.
  for (let start = 0; start < data.products.length; start += 4) {
    productImages.push(...await Promise.all(data.products.slice(start, start + 4).map(product => imageBytes(product.imagePath ?? product.family?.imagePath ?? null))))
    onProgress?.(Math.min(start + 4, data.products.length), data.products.length)
  }
  const count = Math.max(1, Math.ceil(data.products.length / 6))
  for (let pageIndex = 0; pageIndex < count; pageIndex++) {
    const page = pdf.addPage([595.28, 841.89])
    page.drawRectangle({ x: 0, y: 824, width: 596, height: 18, color: brandColor })
    if (logo) { const scale = Math.min(34 / logo.width, 34 / logo.height); page.drawImage(logo, { x: 32, y: 782, width: logo.width * scale, height: logo.height * scale }) }
    write(page, data.restaurant.tradeName, bold, logo ? 76 : 32, 794, 12, logo ? 396 : 440)
    write(page, data.campaign.title, bold, 32, 766, 19, 440, 2)
    write(page, `Precios consultados: ${date}`, font, 32, 717, 9, 450)
    write(page, data.campaign.description, font, 32, 700, 9, 450, 2)
    page.drawImage(qr, { x: 505, y: 734, width: 58, height: 58 })
    for (const [slot, product] of data.products.slice(pageIndex * 6, pageIndex * 6 + 6).entries()) {
      const x = 32 + (slot % 2) * 273; const top = 657 - Math.floor(slot / 2) * 190
      page.drawRectangle({ x, y: top - 175, width: 258, height: 178, borderWidth: 0.5, borderColor: rgb(0.86, 0.87, 0.89) })
      const bytes = productImages[pageIndex * 6 + slot]
      if (bytes) { const image = await pdf.embedPng(bytes); const scale = Math.min(78 / image.width, 78 / image.height); page.drawImage(image, { x: x + 10, y: top - 85, width: image.width * scale, height: image.height * scale }) }
      else write(page, 'Sin foto', font, x + 12, top - 45, 9, 75)
      write(page, cartProductName(product), bold, x + 98, top - 17, 11, 150, 3)
      write(page, `Código: ${product.code}`, font, x + 98, top - 72, 8, 150, 1)
      const price = currentProductPrice(product, now)
      write(page, money(price), bold, x + 10, top - 108, 17, 238)
      const pack = effectiveQuantityPrices(price, product.quantityPrices)[0]
      const threshold = product.quantityThreshold
      const benefit = threshold && threshold.unitPriceCents < price ? `Desde ${threshold.minimumQuantity}: ${money(threshold.unitPriceCents)} c/u`
        : pack ? `${pack.quantity} unidades por ${money(pack.totalPriceCents)}` : ''
      write(page, benefit, font, x + 10, top - 125, 9, 238)
      write(page, product.available ? product.optionGroups.length ? 'Elegí opciones en el catálogo. Adicionales aparte.' : 'Ver producto y disponibilidad online' : 'Agotado al consultar. Revisá disponibilidad online.', font, x + 10, top - 146, 8, 238, 2)
      const productUrl = new URL(productCampaignPath(data.restaurant.slug, channel, product.id, product.family?.id), `${env.appBaseUrl}/`).toString()
      const annotation = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, top - 175, x + 258, top + 3], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(productUrl) } }))
      const annotations = page.node.Annots(); if (annotations) annotations.push(annotation); else page.node.set(PDFName.of('Annots'), pdf.context.obj([annotation]))
    }
    write(page, 'Este PDF es una copia fechada. Precios y stock actuales en el enlace/QR.', font, 32, 66, 9, 530)
    write(page, 'Envíos, extras y ajustes del medio de pago se calculan al finalizar la compra.', font, 32, 51, 8, 530)
    write(page, `${pageIndex + 1} / ${count}`, font, 520, 28, 8, 45)
  }
  const bytes = await pdf.save()
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
}
export async function downloadCampaignPdf(data: PublicCampaign, channel: CommerceChannel, onProgress?: (current: number, total: number) => void) {
  downloadBlob(await createCampaignPdf(data, channel, onProgress), `revista-${data.restaurant.slug}-${data.campaign.slug.slice(0, 8)}.pdf`)
}
