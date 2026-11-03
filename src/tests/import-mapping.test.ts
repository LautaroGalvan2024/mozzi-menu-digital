import { describe, expect, it } from 'vitest'
import { detectImportMapping, normalizeImportHeader, normalizeImportMapping, type ImportMapping, type SourceSheets } from '../lib/import-mapping'

function inspect(sheets: SourceSheets, override: Partial<ImportMapping> = {}) {
  return normalizeImportMapping(sheets, { ...detectImportMapping(sheets), ...override })
}

function reportRow(cells: Record<number, string>) {
  return Array.from({ length: 14 }, (_, column) => cells[column] ?? '')
}

const reportHeaders = reportRow({ 2: 'Ref.', 5: 'Código', 7: 'Nombre', 13: 'Precio + Imp.' })

describe('flexible catalog import mapping', () => {
  it('recognizes grouped reports without including titles, blank rows, or repeated headers as products', () => {
    const sheets = { products: [
      reportRow({ 1: 'Productos' }), reportRow({ 1: 'Filtro: Lista Minorista; Activos' }),
      reportRow({ 3: 'Alimentos para Animales' }), reportHeaders, [],
      reportRow({ 1: '110', 5: '000123', 7: 'Balanceado 20kg', 13: '$ 51.500,00' }),
      reportRow({ 3: 'Bebidas' }), reportHeaders, [],
      reportRow({ 1: '111', 5: 'ABC', 7: 'Agua 1L', 13: '$ 1.250,50' }),
    ] }
    const mapping = detectImportMapping(sheets)
    expect(mapping).toMatchObject({ sheetName: 'products', headerRow: 3, columns: { codigo: 5, nombre: 7, precio: 13 }, categoryMode: 'section', categoryColumn: 3 })
    const result = normalizeImportMapping(sheets, mapping)
    expect(result.errors).toEqual([])
    expect(result.data.products).toEqual([
      { rowRef: '6', code: '000123', name: 'Balanceado 20kg', category: 'Alimentos para Animales', basePriceCents: 5150000 },
      { rowRef: '10', code: 'ABC', name: 'Agua 1L', category: 'Bebidas', basePriceCents: 125050 },
    ])
    expect(result.categoryCount).toBe(2)
    expect(result.rows.filter((row) => row.kind === 'section')).toHaveLength(2)
    expect(result.rows.filter((row) => row.kind === 'header')).toHaveLength(2)
  })

  it('preserves native related-sheet row references and optional patch semantics', () => {
    const sheets: SourceSheets = {
      Productos: [['codigo', 'nombre', 'categoria', 'precio', 'descripcion', 'precio_promocional'], [], ['0001', 'Pizza', 'Pizzas', 100, '', 0]],
      GruposOpciones: [['producto_fila', 'grupo_codigo', 'nombre', 'minimo', 'maximo'], ['3', 'G', 'Extras', 0, 1]],
      Opciones: [['grupo_codigo', 'opcion_codigo', 'nombre', 'precio_adicional'], ['G', 'O', 'Queso', 10]],
    }
    const result = inspect(sheets)
    expect(result.errors).toEqual([])
    expect(result.data.products[0]).toMatchObject({ rowRef: '3', code: '0001', description: '', promotionalPriceCents: 0 })
    expect(result.data.products[0]).not.toHaveProperty('active')
    expect(result.data.groups[0]?.productRowRef).toBe('3')
    expect(result.data.options[0]?.priceDeltaCents).toBe(1000)
  })

  it('keeps omitted optional fields absent and recognizes accented aliases', () => {
    const result = inspect({ Exportación: [[' SKU ', 'Artículo', 'Rúbro', 'P.V.P.'], [' 001 ', 'Arroz', 'Almacén', '1.250,50']] })
    expect(result.errors).toEqual([])
    expect(result.data.products[0]).toEqual({ rowRef: '2', code: '001', name: 'Arroz', category: 'Almacén', basePriceCents: 125050 })
    expect(normalizeImportHeader('\uFEFF  CÓDIGO_producto ')).toBe('codigo producto')
  })

  it('uses an external description as name only when no name column is present', () => {
    const result = inspect({ Lista: [['Referencia', 'Descripción', 'Precio'], ['X', 'Aceite', '100']] }, { categoryMode: 'fixed', fixedCategory: 'General' })
    expect(result.errors).toEqual([])
    expect(result.data.products[0]).toEqual({ rowRef: '2', code: 'X', name: 'Aceite', category: 'General', basePriceCents: 10000 })
  })

  it('requires a user decision for ambiguous prices or identity columns', () => {
    const sheets = { Lista: [['Código', 'EAN', 'Nombre', 'Rubro', 'Precio', 'Precio venta'], ['A', '123', 'Arroz', 'Almacén', '100', '200']] }
    const mapping = detectImportMapping(sheets)
    expect(mapping.columns).not.toHaveProperty('codigo')
    expect(mapping.columns).not.toHaveProperty('precio')
    const result = normalizeImportMapping(sheets, mapping)
    expect(result.errors.join(' ')).toContain('Precio de venta')
    expect(result.warnings.join(' ')).toContain('varias columnas posibles')
    const selected = normalizeImportMapping(sheets, { ...mapping, columns: { ...mapping.columns, codigo: 1, precio: 5 } })
    expect(selected.errors).toEqual([])
    expect(selected.data.products[0]).toMatchObject({ code: '123', basePriceCents: 20000 })
  })

  it('does not interpret an arbitrary external ID as an internal UUID', () => {
    const result = inspect({ Export: [['ID', 'Product name', 'Category', 'Price'], ['X100', 'Coffee', 'Drinks', '10']] })
    expect(result.errors).toEqual([])
    expect(result.data.products[0]?.code).toBe('X100')
    expect(result.data.products[0]).not.toHaveProperty('id')
  })

  it('preserves internal IDs and explicit row references in the native template', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000'
    const result = inspect({ Productos: [['id', 'fila', 'nombre', 'categoria', 'precio'], [id, 'source-20', 'Uno', 'Cat', 100]] })
    expect(result.errors).toEqual([])
    expect(result.data.products[0]).toMatchObject({ id, rowRef: 'source-20' })
  })

  it('supports manual columns, an arbitrary header row and a fixed category', () => {
    const sheets = { Data: [['Exported today'], ['Item key', 'Label to display', 'Tariff'], ['001', 'Arroz', '2,100.50']] }
    const result = normalizeImportMapping(sheets, { sheetName: 'Data', headerRow: 1, columns: { codigo: 0, nombre: 1, precio: 2 }, categoryMode: 'fixed', fixedCategory: 'Almacén', priceFormat: 'decimal-dot', skippedRows: [] })
    expect(result.errors).toEqual([])
    expect(result.data.products[0]).toMatchObject({ rowRef: '3', basePriceCents: 210050, category: 'Almacén' })
  })

  it('shows source-row errors and never drops an unknown nonempty row without an explicit exclusion', () => {
    const sheets = { Lista: [['Reporte'], ['Nombre', 'Rubro', 'Precio', 'Observación'], ['Uno', 'Cat', '10', ''], ['', '', '', 'Información desconocida'], ['Dos', 'Cat', '', '']] }
    const result = inspect(sheets)
    expect(result.errors.join(' ')).toContain('Productos fila 4')
    expect(result.errors.join(' ')).toContain('Productos fila 5')
    expect(result.rows.find((row) => row.sourceRow === 4)?.kind).toBe('invalid')
    const excluded = inspect(sheets, { skippedRows: [4, 5] })
    expect(excluded.errors).toEqual([])
    expect(excluded.data.products).toHaveLength(1)
    expect(excluded.rows.find((row) => row.sourceRow === 4)?.kind).toBe('ignored')
  })

  it('does not infer a product with only a name as a category heading', () => {
    const sheets = { Lista: [['Nombre', 'Precio'], ['Arroz', '100'], ['Aceite', '']] }
    const mapping = detectImportMapping(sheets)
    expect(mapping.categoryMode).toBe('fixed')
    const result = normalizeImportMapping(sheets, { ...mapping, fixedCategory: 'General' })
    expect(result.errors.join(' ')).toContain('Productos fila 3')
    expect(result.rows[2]?.kind).toBe('invalid')
  })

  it('does not treat totals and footers as category sections', () => {
    const sheets = { products: [reportRow({ 3: 'Bebidas' }), reportHeaders, reportRow({ 5: 'A', 7: 'Agua', 13: '$ 100,00' }), reportRow({ 3: 'Total general' })] }
    const result = inspect(sheets)
    expect(result.rows[3]?.kind).toBe('invalid')
    expect(result.errors.join(' ')).toContain('fila 4')
    sheets.products[3] = reportRow({ 3: 'Gracias por su compra' })
    expect(inspect(sheets).rows[3]?.kind).toBe('invalid')
  })

  it.each(['1.234', '1,234'])('requires an explicit separator for ambiguous monetary text %s', (price) => {
    const sheets = { Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['A', 'Uno', 'Cat', price]] }
    expect(inspect(sheets).errors.join(' ')).toContain('ambiguo')
    const result = inspect(sheets, { priceFormat: price.includes('.') ? 'decimal-comma' : 'decimal-dot' })
    expect(result.errors).toEqual([])
    expect(result.data.products[0]?.basePriceCents).toBe(123400)
  })

  it('never reinterprets or rounds a numeric cell with excessive decimal precision', () => {
    const result = inspect({ Productos: [['nombre', 'categoria', 'precio'], ['Uno', 'Cat', 1.234]] }, { priceFormat: 'decimal-comma' })
    expect(result.errors.join(' ')).toContain('dos decimales')
    expect(result.data.products).toHaveLength(0)
  })

  it('handles both unambiguous monetary conventions, zero and grouped spaces without converting currencies', () => {
    const result = inspect({ Productos: [['nombre', 'categoria', 'precio'], ['A', 'Cat', '$ 1.250,50'], ['B', 'Cat', '$1,250.50'], ['C', 'Cat', 0], ['D', 'Cat', 'ARS 1 250,50']] })
    expect(result.errors).toEqual([])
    expect(result.data.products.map((product) => product.basePriceCents)).toEqual([125050, 125050, 0, 125050])
    expect(inspect({ Productos: [['nombre', 'categoria', 'precio'], ['A', 'Cat', 'USD 10']] }).errors.join(' ')).toContain('no es válido')
  })

  it('preserves numeric SKU values with a warning and rejects lost-precision identifiers', () => {
    const result = inspect({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], [123, 'A', 'Cat', 10], ['000123', 'B', 'Cat', 10], [1234567890123456, 'C', 'Cat', 10], [1.5, 'D', 'Cat', 10]] })
    expect(result.data.products.map((product) => product.code)).toEqual(['123', '000123'])
    expect(result.warnings.join(' ')).toContain('código numérico se convirtió')
    expect(result.errors.join(' ')).toContain('15 dígitos')
  })

  it('highlights both rows of a duplicate SKU and warns about missing identity', () => {
    const result = inspect({ Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['ABC', 'Uno', 'Cat', 10], ['abc', 'Dos', 'Cat', 20], ['', 'Tres', 'Cat', 30]] })
    expect(result.errors.join(' ')).toContain('duplicado')
    expect(result.rows[1]?.kind).toBe('invalid')
    expect(result.rows[2]?.kind).toBe('invalid')
    expect(result.warnings.join(' ')).toContain('no tiene código ni ID')
  })

  it('rejects formula/error markers in mapped fields while permitting ignored error columns', () => {
    const sheets = { Productos: [['codigo', 'nombre', 'categoria', 'precio', 'other'], ['A', '#VALUE!', 'Cat', 10, ''], ['B', 'Dos', 'Cat', 20, '#REF!']] }
    const result = inspect(sheets)
    expect(result.rows[1]?.kind).toBe('invalid')
    expect(result.rows[2]?.kind).toBe('product')
    expect(result.errors.join(' ')).toContain('resultado guardado')
    expect(inspect(sheets, { skippedRows: [2] }).errors).toEqual([])
  })

  it('applies the product limit after removing structural report rows', () => {
    const data = [reportRow({ 3: 'Bebidas' }), reportHeaders]
    for (let i = 0; i < 500; i += 1) { data.push(reportRow({ 5: `SKU-${i}`, 7: `Agua ${i}`, 13: '$ 100,00' })); data.push([]) }
    const result = inspect({ products: data })
    expect(result.errors).toEqual([])
    expect(result.data.products).toHaveLength(500)
    data.push(reportRow({ 5: 'SKU-501', 7: 'Agua extra', 13: '$ 100,00' }))
    expect(inspect({ products: data }).errors.join(' ')).toContain('500 productos')
  })

  it('rejects mapping collisions and invalid or absent categories before creating a payload', () => {
    const sheets = { Lista: [['Nombre', 'Precio'], ['A', 10]] }
    const mapping = detectImportMapping(sheets)
    expect(normalizeImportMapping(sheets, mapping).errors.join(' ')).toContain('Escribí la categoría')
    const collision = normalizeImportMapping(sheets, { ...mapping, fixedCategory: 'General', columns: { nombre: 0, precio: 1, codigo: 0 } })
    expect(collision.errors.join(' ')).toContain('más de un campo')
    expect(collision.data.products).toEqual([])
  })

  it('chooses the product table in a workbook with a cover sheet', () => {
    const mapping = detectImportMapping({ Portada: [['Listado de precios'], ['Emitido hoy']], Datos: [['SKU', 'Product name', 'Category', 'Price'], ['A', 'Coffee', 'Drinks', '2']] })
    expect(mapping.sheetName).toBe('Datos')
  })

  it('keeps identity stable when daily updates change prices, names and row order', () => {
    const first = { Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['001', 'Uno', 'Cat', 10], ['002', 'Dos', 'Cat', 20]] }
    const next = { Productos: [['codigo', 'nombre', 'categoria', 'precio'], ['002', 'Nombre actualizado', 'Cat', 22], ['001', 'Uno', 'Cat', 11]] }
    const before = inspect(first)
    const after = normalizeImportMapping(next, detectImportMapping(first))
    expect(after.errors).toEqual([])
    expect(after.data.products.map((product) => product.code).sort()).toEqual(before.data.products.map((product) => product.code).sort())
    expect(after.data.products.find((product) => product.code === '002')).toMatchObject({ name: 'Nombre actualizado', basePriceCents: 2200 })
  })
})
