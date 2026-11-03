// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { readImportFile, MAX_SPREADSHEET_BYTES, MAX_SOURCE_COLUMNS, MAX_SOURCE_ROWS } from '../lib/import-file'

function workbookFile(sheets: Record<string, XLSX.WorkSheet>, bookType: 'xlsx' | 'biff8' | 'ods' = 'xlsx') {
  const workbook = XLSX.utils.book_new()
  for (const [name, sheet] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, sheet, name)
  const bytes = XLSX.write(workbook, { type: 'array', bookType }) as ArrayBuffer
  return new File([bytes], `productos.${bookType === 'biff8' ? 'xls' : bookType}`)
}

describe('flexible import file reader', () => {
  it.each(['xlsx', 'biff8', 'ods'] as const)('reads %s with arbitrary sheet names and source row coordinates', async (bookType) => {
    const sheet = XLSX.utils.aoa_to_sheet([
      [],
      [null, 'Lista de precios'],
      [null, 'SKU', 'Artículo', 'Precio'],
      [null, '000123', 'Café', 1500.25],
    ])
    const result = await readImportFile(workbookFile({ 'Lista minorista': sheet }, bookType))
    expect(Object.keys(result)).toEqual(['Lista minorista'])
    expect(result['Lista minorista']?.[0]).toEqual([null, null, null, null])
    expect(result['Lista minorista']?.[3]).toEqual([null, '000123', 'Café', 1500.25])
  })

  it('preserves the native multi-sheet import and all optional empty cells', async () => {
    const sheets = {
      Productos: XLSX.utils.aoa_to_sheet([['nombre', 'categoria', 'precio', 'descripcion'], ['Café', 'Bebidas', 100, '']]),
      GruposOpciones: XLSX.utils.aoa_to_sheet([['grupo_codigo', 'producto_fila'], ['G1', '2']]),
      Opciones: XLSX.utils.aoa_to_sheet([['grupo_codigo', 'nombre', 'precio_adicional'], ['G1', 'Leche', 0]]),
    }
    const result = await readImportFile(workbookFile(sheets))
    expect(Object.keys(result)).toEqual(['Productos', 'GruposOpciones', 'Opciones'])
    expect(result.Productos?.[1]).toEqual(['Café', 'Bebidas', 100, ''])
    expect(result.Opciones?.[1]?.[2]).toBe(0)
  })

  it('keeps zero-padded codes and raw prices without rounding display values', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Código', 'Precio'], [123, 12.345], [7791234567890, 10], [1234567890123456, 0]])
    sheet.A2!.z = '000000'
    sheet.B2!.z = '$0.00'
    sheet.A3!.z = '0.00E+00'
    const result = await readImportFile(workbookFile({ Productos: sheet }))
    expect(result.Productos?.[1]).toEqual(['000123', 12.345])
    expect(result.Productos?.[2]?.[0]).toBe(7791234567890)
    expect(result.Productos?.[3]?.[0]).toBe(1234567890123456)
  })

  it('reads cached formula results without evaluating formulas or external references', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['nombre', 'precio'], ['Café', 2]])
    sheet.B2 = { t: 'n', v: 120, f: '10*12' }
    sheet.A3 = { t: 's', v: 'Otro producto' }
    sheet.B3 = { t: 'n', f: "'[external.xlsx]Prices'!B2" }
    sheet.A4 = { t: 's', v: 'Con error' }
    sheet.B4 = { t: 'e', v: 0x07 }
    sheet['!ref'] = 'A1:B4'
    const result = await readImportFile(workbookFile({ Productos: sheet }))
    expect(result.Productos?.[1]?.[1]).toBe(120)
    expect(result.Productos?.[2]?.[1]).toBe('#SIN_VALOR_CALCULADO')
    expect(result.Productos?.[3]?.[1]).toBe('#DIV/0!')
  })

  it('keeps date cells as unambiguous ISO timestamps', async () => {
    const date = new Date('2026-11-03T12:00:00Z')
    const sheet = XLSX.utils.aoa_to_sheet([['promocion_desde'], [(date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000]])
    sheet.A2!.z = 'yyyy-mm-dd hh:mm:ss'
    const result = await readImportFile(workbookFile({ Productos: sheet }))
    expect(result.Productos?.[1]?.[0]).toEqual(date.toISOString())
  })

  it('reads semicolon CSV with title rows, accents, quoted delimiters and codes as text', async () => {
    const file = new File(['\uFEFFLista minorista\nCódigo;Artículo;Precio\n0001;"Café; molido";"1.500,50"\n'], 'precios.csv')
    const result = await readImportFile(file)
    expect(result.Productos?.slice(0, 3)).toEqual([
      ['Lista minorista'], ['Código', 'Artículo', 'Precio'], ['0001', 'Café; molido', '1.500,50'],
    ])
  })

  it('reads TSV and Excel separator directives without shifting source rows', async () => {
    expect((await readImportFile(new File(['SKU\tNombre\tPrecio\n001\tCafé\t10.25'], 'precios.tsv'))).Productos?.[1]).toEqual(['001', 'Café', '10.25'])
    const result = await readImportFile(new File(['sep=;\r\nSKU;Nombre;Precio\r\n001;Café;10,25'], 'precios.csv'))
    expect(result.Productos).toEqual([['sep=;'], ['SKU', 'Nombre', 'Precio'], ['001', 'Café', '10,25']])
  })

  it('decodes Windows-1252 and UTF-16 CSV exports', async () => {
    const windows = Uint8Array.from([67, 243, 100, 105, 103, 111, 59, 78, 111, 109, 98, 114, 101, 10, 48, 48, 49, 59, 67, 97, 102, 233])
    expect((await readImportFile(new File([windows], 'windows.csv'))).Productos).toEqual([['Código', 'Nombre'], ['001', 'Café']])
    const utf16 = Buffer.from('\uFEFFCódigo\tNombre\n001\tCafé', 'utf16le')
    expect((await readImportFile(new File([utf16], 'unicode.tsv'))).Productos?.[1]).toEqual(['001', 'Café'])
  })

  it('rejects malformed CSV quotes rather than truncating a row', async () => {
    await expect(readImportFile(new File(['nombre,precio\n"Café,1500'], 'malformed.csv'))).rejects.toThrow(/comillas/)
  })

  it('rejects empty, unsupported and mislabeled files', async () => {
    await expect(readImportFile(new File([], 'empty.xlsx'))).rejects.toThrow(/vacío/)
    await expect(readImportFile(new File(['text'], 'text.pdf'))).rejects.toThrow(/Formato no compatible/)
    await expect(readImportFile(new File(['not an excel file'], 'text.xlsx'))).rejects.toThrow(/contenido no corresponde/)
  })

  it('enforces input size before reading the file', async () => {
    const file = new File(['not read'], 'large.xlsx')
    Object.defineProperty(file, 'size', { value: MAX_SPREADSHEET_BYTES + 1 })
    await expect(readImportFile(file)).rejects.toThrow(/10 MB/)
  })

  it('rejects over-limit source rows and columns without returning partial data', async () => {
    const tall = new File([Array.from({ length: MAX_SOURCE_ROWS + 1 }, () => 'A;B;C').join('\n')], 'large.csv')
    await expect(readImportFile(tall)).rejects.toThrow(/límite de lectura/)
    const wide = XLSX.utils.aoa_to_sheet([Array.from({ length: MAX_SOURCE_COLUMNS + 1 }, () => 'dato')])
    await expect(readImportFile(workbookFile({ Productos: wide }))).rejects.toThrow(/límite de lectura/)
  })
})
