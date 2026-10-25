import JSZip from 'jszip'
import type { ImportData } from './import-products'
import type { ImportResult } from './import-session'

const xml = (value: unknown) => Array.from(String(value ?? '')).filter((character) => character.charCodeAt(0) >= 32 || ['\t', '\n', '\r'].includes(character)).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const letters = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : `${letters(Math.floor(index / 26) - 1)}${letters(index % 26)}`

// All cells are inline strings, never formulas. Excel preserves SKU zeros and
// formula-looking codes unchanged, and our reader returns them as text.
export async function importWorkbook(sheets: Record<string, unknown[][]>): Promise<Blob> {
  const zip = new JSZip()
  const entries = Object.entries(sheets)
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${entries.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${entries.map(([name], index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`)
  entries.forEach(([, rows], index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, column) => `<c r="${letters(column)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`))
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' })
}

export async function importResultWorkbook(data: ImportData, result: ImportResult): Promise<Blob> {
  const byRef = new Map(data.products.map((product) => [product.rowRef, product]))
  // Only emit optional columns that were supplied. Their absence remains a patch
  // on reimport, rather than clearing promotions/flags through empty cells.
  const optional = [
    ['description', 'descripcion'], ['promotionalPriceCents', 'precio_promocional'], ['promotionStartsAt', 'promocion_desde'], ['promotionEndsAt', 'promocion_hasta'], ['active', 'activo'], ['available', 'disponible'], ['featured', 'destacado'], ['sortOrder', 'orden'], ['imageFilename', 'imagen_archivo'],
  ] as const
  const columns = optional.filter(([field]) => data.products.every((product) => Object.hasOwn(product, field)))
  return importWorkbook({ Productos: [
    ['fila', 'id', 'codigo', 'nombre', 'categoria', 'precio', ...columns.map(([, header]) => header), 'resultado'],
    ...result.products.map((item) => {
      const product = byRef.get(item.rowRef)
      return [item.rowRef, item.id, item.code, product?.name, product?.category, product ? (product.basePriceCents / 100).toFixed(2) : '', ...columns.map(([field]) => {
        const value = product?.[field]
        return field === 'promotionalPriceCents' && typeof value === 'number' ? (value / 100).toFixed(2) : typeof value === 'boolean' ? (value ? 'sí' : 'no') : value ?? ''
      }), item.outcome]
    }),
  ] })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
