import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import readXlsxFile from 'read-excel-file/browser'
import { importResultWorkbook, importWorkbook } from '../lib/import-workbook'
import { parseImportSheets } from '../lib/import-products'

describe('safe SKU result workbook', () => {
  it('never silently truncates a numeric Excel SKU formatted with leading zeros', async () => {
    const blob = await importWorkbook({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['000123', 'Uno', 'Cat', '100.00']] })
    const zip = await JSZip.loadAsync(blob)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    zip.file('xl/worksheets/sheet1.xml', sheet.replace('<c r="A2" t="inlineStr"><is><t xml:space="preserve">000123</t></is></c>', '<c r="A2" s="1"><v>123</v></c>'))
    zip.file('xl/styles.xml', '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>')
    const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
    zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'))
    const workbook = await readXlsxFile(await zip.generateAsync({ type: 'blob' }))
    const parsed = parseImportSheets(Object.fromEntries(workbook.map((item) => [item.sheet, item.data])))
    expect(parsed.products.some((product) => product.code === '123')).toBe(false)
    expect(parsed.products[0]?.code === '000123' || parsed.errors.some((error) => error.includes('como texto en Excel'))).toBe(true)
  })
  it('round trips textual zeros and formula-looking codes with row identities', async () => {
    const data = parseImportSheets({ Productos: [['nombre', 'categoria', 'precio'], ['Uno', 'Cat', '100'], ['Dos', 'Cat', '200']] })
    const blob = await importResultWorkbook(data, {
      batchId: '10000000-0000-4000-8000-000000000001', summary: { created: 2, updated: 0, skipped: 0 }, errors: [],
      products: [
        { rowRef: '2', id: '10000000-0000-4000-8000-000000000002', code: '000123', outcome: 'created' },
        { rowRef: '3', id: '10000000-0000-4000-8000-000000000003', code: '=1+1', outcome: 'created' },
      ],
    })
    const zip = await JSZip.loadAsync(blob)
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheetXml).not.toContain('<f>')
    expect(sheetXml).toContain('t="inlineStr"')
    const workbook = await readXlsxFile(blob)
    const parsed = parseImportSheets(Object.fromEntries(workbook.map((sheet) => [sheet.sheet, sheet.data])))
    expect(parsed.errors).toEqual([])
    expect(parsed.products.map((product) => product.code)).toEqual(['000123', '=1+1'])
    expect(parsed.products.map((product) => product.rowRef)).toEqual(['2', '3'])
    expect(parsed.products[0]).not.toHaveProperty('available')
    expect(parsed.products[0]).not.toHaveProperty('promotionalPriceCents')
  })
})
