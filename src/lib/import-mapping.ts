import type { CellValue, SheetData } from 'read-excel-file/browser'
import { parseImportSheets, type ImportData } from './import-products'
import { parsePriceCents } from './money'

const FIELD_DEFINITIONS = [
  { key: 'nombre', label: 'Nombre', required: true },
  { key: 'codigo', label: 'Código / SKU' },
  { key: 'categoria', label: 'Categoría', required: true },
  { key: 'precio', label: 'Precio de venta', required: true },
  { key: 'descripcion', label: 'Descripción' },
  { key: 'precio_promocional', label: 'Precio promocional' },
  { key: 'activo', label: 'Activo' },
  { key: 'disponible', label: 'Disponible' },
  { key: 'destacado', label: 'Destacado' },
  { key: 'orden', label: 'Orden' },
  { key: 'imagen_archivo', label: 'Archivo de imagen' },
  { key: 'promocion_desde', label: 'Promoción desde' },
  { key: 'promocion_hasta', label: 'Promoción hasta' },
  { key: 'familia_codigo', label: 'Código de familia' },
  { key: 'familia_nombre', label: 'Nombre de familia' },
  { key: 'atributo_1', label: 'Atributo 1' },
  { key: 'valor_1', label: 'Valor 1' },
  { key: 'atributo_2', label: 'Atributo 2' },
  { key: 'valor_2', label: 'Valor 2' },
  { key: 'atributo_3', label: 'Atributo 3' },
  { key: 'valor_3', label: 'Valor 3' },
  { key: 'id', label: 'ID de Mozzi (UUID)' },
  { key: 'fila', label: 'Referencia de fila' },
] as const

export type ImportField = typeof FIELD_DEFINITIONS[number]['key']
export const IMPORT_FIELDS: readonly { key: ImportField; label: string; required?: boolean }[] = FIELD_DEFINITIONS
export type SourceSheets = Record<string, SheetData>
export interface ImportMapping {
  sheetName: string
  /** Zero-based index in the original sheet. */
  headerRow: number
  columns: Partial<Record<ImportField, number>>
  categoryMode: 'column' | 'section' | 'fixed'
  categoryColumn?: number | undefined
  fixedCategory: string
  priceFormat: 'auto' | 'decimal-comma' | 'decimal-dot'
  /** One-based physical rows explicitly excluded by the user. */
  skippedRows: number[]
}

export interface ImportPreviewRow {
  sourceRow: number
  kind: 'product' | 'section' | 'header' | 'empty' | 'ignored' | 'invalid'
  values: Partial<Record<ImportField, string>>
  issues: string[]
}

export interface ImportNormalization {
  data: ImportData
  rows: ImportPreviewRow[]
  ignoredColumns: number[]
  warnings: string[]
  errors: string[]
  /** Preamble and explicitly excluded rows; blanks and recognized headings are separate. */
  skippedCount: number
  categoryCount: number
}

const fieldKeys = new Set<string>(IMPORT_FIELDS.map(({ key }) => key))
const text = (value: unknown): string => value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value).trim()

export function normalizeImportHeader(value: unknown): string {
  return text(value).replace(/^\uFEFF/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/[^a-z0-9]+/g, ' ').trim()
}

const aliases: Partial<Record<ImportField, string[]>> = {
  nombre: ['nombre', 'producto', 'articulo', 'nombre producto', 'nombre del producto', 'nombre articulo', 'denominacion', 'product', 'product name', 'item', 'item name', 'name'],
  codigo: ['codigo', 'cod', 'sku', 'codigo sku', 'codigo producto', 'codigo del producto', 'codigo articulo', 'cod articulo', 'codigo de barras', 'codigo barras', 'cod barras', 'ean', 'ean13', 'ean 13', 'barcode', 'product code', 'item code', 'code'],
  categoria: ['categoria', 'rubro', 'grupo', 'seccion', 'departamento', 'category', 'category name', 'department'],
  precio: ['precio', 'precio venta', 'precio de venta', 'precio al publico', 'precio publico', 'precio final', 'precio con iva', 'precio iva incluido', 'precio imp', 'precio mas imp', 'precio impuestos', 'precio minorista', 'lista minorista', 'pvp', 'p v p', 'p venta', 'price', 'sale price', 'retail price', 'unit price'],
  descripcion: ['descripcion', 'descripcion producto', 'descripcion del producto', 'detalle', 'description', 'product description'],
  precio_promocional: ['precio promocional', 'precio oferta', 'precio de oferta', 'precio promo', 'oferta', 'special price', 'discount price'],
  activo: ['activo', 'active'],
  disponible: ['disponible', 'available'],
  destacado: ['destacado', 'featured'],
  orden: ['orden', 'sort order'],
  imagen_archivo: ['imagen archivo', 'archivo imagen', 'image filename'],
  promocion_desde: ['promocion desde', 'promotion starts at'],
  promocion_hasta: ['promocion hasta', 'promotion ends at'],
  familia_codigo: ['familia codigo', 'codigo familia', 'family code'],
  familia_nombre: ['familia nombre', 'nombre familia', 'family name'],
  atributo_1: ['atributo 1', 'attribute 1'], valor_1: ['valor 1', 'value 1'],
  atributo_2: ['atributo 2', 'attribute 2'], valor_2: ['valor 2', 'value 2'],
  atributo_3: ['atributo 3', 'attribute 3'], valor_3: ['valor 3', 'value 3'],
  id: ['id mozzi', 'uuid'], fila: ['fila', 'row ref'],
}

function headerMapping(row: SheetData[number], native: boolean) {
  const headers = row.map(normalizeImportHeader)
  const columns: ImportMapping['columns'] = {}
  const ambiguous: ImportField[] = []
  for (const { key } of IMPORT_FIELDS) {
    const names = aliases[key] ?? [normalizeImportHeader(key)]
    const matches = headers.flatMap((header, index) => names.includes(header) || (native && key === 'id' && header === 'id') ? [index] : [])
    if (matches.length === 1) columns[key] = matches[0]!
    else if (matches.length > 1) ambiguous.push(key)
  }
  // Many exports call the product name “Descripción”. Only use that alias
  // when a real name column is absent, so a native description remains a patch.
  if (columns.nombre === undefined && !ambiguous.includes('nombre') && columns.descripcion !== undefined && columns.precio !== undefined) {
    columns.nombre = columns.descripcion
    delete columns.descripcion
  }
  // A report can include both an internal reference and a barcode. Prefer its
  // explicit code; do not guess between two actual code or selling-price columns.
  if (columns.codigo === undefined && !ambiguous.includes('codigo')) {
    const fallback = headers.flatMap((header, index) => ['ref', 'referencia', 'reference', ...(!native ? ['id'] : [])].includes(header) ? [index] : [])
    if (fallback.length === 1) columns.codigo = fallback[0]!
  }
  return { columns, ambiguous }
}

function nativeHeader(sheetName: string, row: SheetData[number]) {
  const headers = row.map(normalizeImportHeader)
  return normalizeImportHeader(sheetName) === 'productos' && ['nombre', 'categoria', 'precio'].every((name) => headers.includes(name))
}

function isSectionText(value: unknown) {
  const valueText = text(value)
  return Boolean(valueText) && /[\p{L}]/u.test(valueText) && !/^(?:total(?:es)?|subtotal|filtro|pagina|page|reporte|listado|productos|fecha)(?:\b|:)/i.test(normalizeImportHeader(valueText))
}

function detectSectionColumn(data: SheetData, headerRow: number, columns: ImportMapping['columns']) {
  const reserved = new Set(Object.values(columns))
  const counts = new Map<number, number>()
  let preceding = headerRow - 1
  while (preceding >= 0 && !data[preceding]?.some((value) => text(value))) preceding -= 1
  data.forEach((row, index) => {
    if (index < headerRow && index !== preceding) return
    const populated = row.flatMap((value, column) => text(value) ? [column] : [])
    const column = populated[0]
    if (populated.length !== 1 || column === undefined || reserved.has(column) || !isSectionText(row[column])) return
    // A category must introduce content, not merely occur in a trailing note.
    const follows = data.slice(index + 1, index + 5).some((next) => columns.nombre !== undefined && columns.precio !== undefined && text(next[columns.nombre]) && text(next[columns.precio]))
    if (follows) counts.set(column, (counts.get(column) ?? 0) + 1)
  })
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  if (!ranked[0] || (ranked[1] && ranked[0][1] === ranked[1][1])) return undefined
  const [column, count] = ranked[0]
  return count >= 2 || (preceding >= 0 && text(data[preceding]?.[column])) ? column : undefined
}

export function detectImportMapping(sheets: SourceSheets): ImportMapping {
  let best: { sheetName: string; headerRow: number; columns: ImportMapping['columns']; score: number } | undefined
  for (const [sheetName, data] of Object.entries(sheets)) {
    if (['gruposopciones', 'opciones'].includes(normalizeImportHeader(sheetName))) continue
    for (let headerRow = 0; headerRow < Math.min(data.length, 100); headerRow += 1) {
      const row = data[headerRow] ?? []
      if (!row.some((value) => text(value))) continue
      const native = nativeHeader(sheetName, row)
      const { columns } = headerMapping(row, native)
      const score = Object.keys(columns).length + (columns.nombre !== undefined ? 20 : 0) + (columns.precio !== undefined ? 20 : 0) + (columns.codigo !== undefined ? 4 : 0) + (columns.categoria !== undefined ? 4 : 0) + (native ? 1 : 0)
      if (!best || score > best.score) best = { sheetName, headerRow, columns, score }
    }
  }
  const sheetName = best?.sheetName ?? Object.keys(sheets)[0] ?? ''
  const headerRow = best?.headerRow ?? 0
  const columns = best?.columns ?? {}
  const categoryColumn = columns.categoria === undefined ? detectSectionColumn(sheets[sheetName] ?? [], headerRow, columns) : undefined
  return { sheetName, headerRow, columns, categoryMode: columns.categoria !== undefined ? 'column' : categoryColumn !== undefined ? 'section' : 'fixed', ...(categoryColumn !== undefined ? { categoryColumn } : {}), fixedCategory: '', priceFormat: 'auto', skippedRows: [] }
}

function normalizePrice(value: CellValue | null | undefined, format: ImportMapping['priceFormat']): { value: CellValue | null; issue?: string } {
  if (value === null || value === undefined || text(value) === '') return { value: null }
  // Numeric cells already have an unambiguous decimal value. Never reinterpret
  // 1.234 as 1234 merely because the chosen text format has decimal commas.
  if (typeof value === 'number') return parsePriceCents(value) === null ? { value, issue: 'El precio numérico debe ser no negativo y tener como máximo dos decimales.' } : { value }
  let raw = text(value).replace(/^(?:AR\$|ARS|\$)\s*/i, '').replace(/\s*(?:ARS|\$)$/i, '').trim()
  if (/^\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d{1,2})?$/.test(raw)) raw = raw.replace(/[ \u00a0]/g, '')
  let normalized: string | undefined
  if (format === 'decimal-comma') {
    if (/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw)) normalized = raw.replace(/\./g, '').replace(',', '.')
  } else if (format === 'decimal-dot') {
    if (/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) normalized = raw.replace(/,/g, '')
  } else {
    if (/^\d+(?:[.,]\d{1,2})?$/.test(raw)) normalized = raw.replace(',', '.')
    else if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(raw)) normalized = raw.replace(/\./g, '').replace(',', '.')
    else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(raw)) normalized = raw.replace(/,/g, '')
    else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return { value: raw, issue: `El precio «${text(value)}» es ambiguo. Elegí el separador decimal del archivo.` }
  }
  if (normalized === undefined || parsePriceCents(normalized) === null) return { value: raw, issue: `El precio «${text(value)}» no es válido para el formato elegido.` }
  return { value: normalized }
}

const excelError = /^#(?:ERROR!|NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|BUSY!|GETTING_DATA|SIN_VALOR_CALCULADO|¡VALOR!|¡REF!|¡DIV\/0!|¿NOMBRE\?)/i

export function normalizeImportMapping(sheets: SourceSheets, mapping: ImportMapping): ImportNormalization {
  const source = sheets[mapping.sheetName]
  const rows: ImportPreviewRow[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const configurationErrors: string[] = []
  const width = source?.reduce((maximum, row) => Math.max(maximum, row.length), 0) ?? 0
  const entries = Object.entries(mapping.columns).filter(([field]) => fieldKeys.has(field)) as [ImportField, number][]
  const assigned = new Set(entries.map(([, column]) => column))
  const used = new Set(assigned)
  if (mapping.categoryMode === 'section' && mapping.categoryColumn !== undefined) used.add(mapping.categoryColumn)
  const ignoredColumns = Array.from({ length: width }, (_, index) => index).filter((column) => !used.has(column) && source?.some((row) => text(row[column])))
  if (!source) configurationErrors.push('Elegí una hoja del archivo.')
  if (!Number.isInteger(mapping.headerRow) || mapping.headerRow < 0 || mapping.headerRow >= (source?.length ?? 0)) configurationErrors.push('Elegí una fila de encabezados válida.')
  if (entries.some(([, column]) => !Number.isInteger(column) || column < 0 || column >= width)) configurationErrors.push('Una columna relacionada ya no existe. Revisá la configuración.')
  if (assigned.size !== entries.length) configurationErrors.push('Una misma columna no puede estar relacionada con más de un campo.')
  for (const field of ['nombre', 'precio'] as const) if (mapping.columns[field] === undefined) configurationErrors.push(`Relacioná una columna con ${field === 'nombre' ? 'Nombre' : 'Precio de venta'}.`)
  if (mapping.categoryMode === 'column' && mapping.columns.categoria === undefined) configurationErrors.push('Relacioná una columna con Categoría.')
  if (mapping.categoryMode === 'fixed' && !mapping.fixedCategory.trim()) configurationErrors.push('Escribí la categoría que se usará para estos productos.')
  if (mapping.categoryMode === 'section' && (mapping.categoryColumn === undefined || !Number.isInteger(mapping.categoryColumn) || mapping.categoryColumn < 0 || mapping.categoryColumn >= width)) configurationErrors.push('Elegí la columna de los títulos de categoría.')
  if (!['column', 'section', 'fixed'].includes(mapping.categoryMode)) configurationErrors.push('Elegí cómo se obtiene la categoría.')
  if (!['auto', 'decimal-comma', 'decimal-dot'].includes(mapping.priceFormat)) configurationErrors.push('Elegí un formato de precios válido.')

  const header = source?.[mapping.headerRow] ?? []
  const detected = headerMapping(header, nativeHeader(mapping.sheetName, header))
  for (const field of detected.ambiguous) {
    if (mapping.columns[field] === undefined) warnings.push(`Hay varias columnas posibles para ${IMPORT_FIELDS.find(({ key }) => key === field)?.label ?? field}. Elegí cuál usar.`)
  }
  const skipped = new Set(mapping.skippedRows.filter((row) => Number.isInteger(row) && row > 0))
  const normalizedHeaders = [...new Set<ImportField>(['fila', ...entries.map(([field]) => field), 'categoria'])]
  const normalized: SheetData = [normalizedHeaders]
  const productRows: ImportPreviewRow[] = []
  let category = ''
  let numericCodes = 0

  for (let index = 0; index < (source?.length ?? 0); index += 1) {
    const row = source![index] ?? []
    const sourceRow = index + 1
    const values: ImportPreviewRow['values'] = Object.fromEntries(entries.map(([field, column]) => [field, text(row[column])]))
    const preview: ImportPreviewRow = { sourceRow, kind: 'product', values, issues: [] }
    rows.push(preview)
    const populated = row.flatMap((value, column) => text(value) ? [column] : [])
    if (skipped.has(sourceRow)) { preview.kind = 'ignored'; continue }
    if (index === mapping.headerRow) { preview.kind = 'header'; continue }
    if (!populated.length) { preview.kind = 'empty'; continue }
    const section = mapping.categoryColumn
    const sectionHasContent = source?.slice(index + 1, index + 5).some((next) => mapping.columns.nombre !== undefined && mapping.columns.precio !== undefined && text(next[mapping.columns.nombre]) && text(next[mapping.columns.precio]))
    if (mapping.categoryMode === 'section' && section !== undefined && populated.length === 1 && populated[0] === section && isSectionText(row[section]) && sectionHasContent) {
      category = text(row[section])
      preview.kind = 'section'
      preview.values.categoria = category
      continue
    }
    if (index < mapping.headerRow) { preview.kind = 'ignored'; continue }
    const matchesHeader = (field: ImportField) => mapping.columns[field] !== undefined && text(header[mapping.columns[field]!]) && normalizeImportHeader(row[mapping.columns[field]!]) === normalizeImportHeader(header[mapping.columns[field]!])
    if (matchesHeader('nombre') && matchesHeader('precio') && entries.every(([, column]) => !text(row[column]) || normalizeImportHeader(row[column]) === normalizeImportHeader(header[column]))) {
      preview.kind = 'header'
      continue
    }

    const record: Partial<Record<ImportField, CellValue | null>> = Object.fromEntries(entries.map(([field, column]) => [field, row[column] ?? null]))
    record.fila = text(record.fila) || String(sourceRow)
    if (mapping.categoryMode === 'section') record.categoria = category
    if (mapping.categoryMode === 'fixed') record.categoria = mapping.fixedCategory.trim()
    if (!entries.some(([, column]) => text(row[column]))) preview.issues.push('Hay datos en columnas no relacionadas. Revisá esta fila o excluila explícitamente.')
    for (const [field, value] of Object.entries(record)) {
      if (excelError.test(text(value))) preview.issues.push(`${IMPORT_FIELDS.find(({ key }) => key === field)?.label ?? field}: la celda contiene un error o una fórmula sin resultado guardado.`)
    }
    for (const field of ['precio', 'precio_promocional'] as const) {
      if (mapping.columns[field] === undefined) continue
      const price = normalizePrice(record[field], mapping.priceFormat)
      record[field] = price.value
      if (price.issue) preview.issues.push(`${field === 'precio' ? 'Precio' : 'Precio promocional'}: ${price.issue}`)
    }
    if (typeof record.codigo === 'number') {
      if (Number.isSafeInteger(record.codigo) && record.codigo >= 0 && String(record.codigo).length <= 15) {
        record.codigo = String(record.codigo)
        numericCodes += 1
      } else preview.issues.push('Código / SKU: el código numérico no es un entero de hasta 15 dígitos. Usá el código original como texto para conservar su identidad.')
    }
    for (const field of normalizedHeaders) if (record[field] !== undefined) preview.values[field] = text(record[field])
    normalized.push(normalizedHeaders.map((field) => record[field] ?? null))
    productRows.push(preview)
  }

  if (numericCodes) warnings.push(`${numericCodes} ${numericCodes === 1 ? 'código numérico se convirtió' : 'códigos numéricos se convirtieron'} a texto. Revisá que coincidan con los códigos originales; los ceros ya perdidos en el archivo no se pueden recuperar.`)
  const related = Object.fromEntries(Object.entries(sheets).filter(([name]) => ['gruposopciones', 'opciones'].includes(normalizeImportHeader(name))))
  const data: ImportData = configurationErrors.length ? { products: [], groups: [], options: [], errors: [] } : parseImportSheets({ ...related, Productos: normalized })
  const remapError = (message: string) => message.replace(/Productos fila (\d+):/g, (_, row: string) => `Productos fila ${productRows[Number(row) - 2]?.sourceRow ?? row}:`)
  for (const message of data.errors.map(remapError)) {
    errors.push(message)
    const physical = /^Productos fila (\d+):/.exec(message)
    if (physical) rows.find((row) => row.sourceRow === Number(physical[1]))?.issues.push(message.replace(/^Productos fila \d+:\s*/, ''))
    else {
      const duplicateCode = /^Código de producto duplicado: (.*)\.$/.exec(message)
      const duplicateRef = /^Fila de producto duplicada: (.*)\.$/.exec(message)
      const rowRef = /en fila ([^.]+)\./.exec(message)
      const family = /^Familia ([^:]+):/.exec(message)
      const affected = duplicateCode ? productRows.filter((row) => text(row.values.codigo).toLocaleLowerCase('en') === duplicateCode[1]!.toLocaleLowerCase('en'))
        : duplicateRef ? productRows.filter((row) => row.values.fila === duplicateRef[1])
          : rowRef ? productRows.filter((row) => row.values.fila === rowRef[1])
            : family ? productRows.filter((row) => text(row.values.familia_codigo).toLocaleLowerCase('es') === family[1]!.toLocaleLowerCase('es')) : []
      affected.forEach((row) => row.issues.push(message))
    }
  }
  errors.push(...configurationErrors)
  for (const row of productRows) {
    if (row.issues.length) {
      row.kind = 'invalid'
      row.issues = [...new Set(row.issues)]
      row.issues.forEach((issue) => {
        const message = `Productos fila ${row.sourceRow}: ${issue}`
        if (!errors.includes(message) && !errors.includes(issue)) errors.push(message)
      })
    } else if (configurationErrors.length) row.kind = 'invalid'
  }
  const unidentified = data.products.filter((product) => !product.code && !product.id).length
  if (unidentified) warnings.push(`${unidentified} ${unidentified === 1 ? 'producto no tiene' : 'productos no tienen'} código ni ID. Si volvés a cargarlo en otro lote puede crear duplicados; relacioná un identificador estable para las actualizaciones.`)
  data.errors = [...new Set(errors)]
  return { data, rows, ignoredColumns, warnings, errors: data.errors, skippedCount: rows.filter((row) => row.kind === 'ignored').length, categoryCount: new Set(data.products.map((product) => product.category)).size }
}
