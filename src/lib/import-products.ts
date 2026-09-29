import type { CellValue, SheetData } from 'read-excel-file/browser'

export interface ImportProduct {
  code: string
  name: string
  description: string
  category: string
  basePriceCents: number
  promotionalPriceCents: number | null
  promotionStartsAt: string | null
  promotionEndsAt: string | null
  active: boolean
  available: boolean
  featured: boolean
  sortOrder: number
  imageFilename: string | undefined
}

export interface ImportGroup {
  productCode: string
  groupCode: string
  name: string
  required: boolean
  minSelect: number
  maxSelect: number
  sortOrder: number
  active: boolean
}

export interface ImportOption {
  groupCode: string
  optionCode: string
  name: string
  priceDeltaCents: number
  sortOrder: number
  active: boolean
}

export interface ImportData {
  products: ImportProduct[]
  groups: ImportGroup[]
  options: ImportOption[]
  errors: string[]
}

type SheetRecord = Record<string, CellValue | null>
const MAX_CENTS = 1_000_000_000_000
const MIN_SORT_ORDER = -100_000
const MAX_SORT_ORDER = 100_000

function stringValue(value: CellValue | null | undefined) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function numberValue(value: CellValue | null | undefined) {
  if (typeof value === 'number') return value
  const raw = stringValue(value).replace(/\s/g, '')
  if (!raw) return Number.NaN
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function centsValue(value: CellValue | null | undefined) {
  const cents = Math.round(numberValue(value) * 100)
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_CENTS ? cents : null
}

function sortOrderValue(value: CellValue | null | undefined) {
  if (!stringValue(value)) return 0
  const parsed = numberValue(value)
  return Number.isInteger(parsed) && parsed >= MIN_SORT_ORDER && parsed <= MAX_SORT_ORDER
    ? parsed
    : null
}

function booleanValue(value: CellValue | null | undefined, defaultValue: boolean) {
  const normalized = stringValue(value).toLocaleLowerCase('es')
  if (!normalized) return defaultValue
  if (['1', 'si', 'sí', 'true', 'verdadero', 'yes'].includes(normalized)) return true
  if (['0', 'no', 'false', 'falso'].includes(normalized)) return false
  return null
}

function dateValue(value: CellValue | null | undefined) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function sheetByName(sheets: Record<string, SheetData>, name: string) {
  const match = Object.entries(sheets).find(([candidate]) => candidate.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))
  return match?.[1] ?? []
}

function headers(data: SheetData) {
  return new Set((data[0] ?? []).map((cell) => stringValue(cell).toLocaleLowerCase('es')))
}

function requireColumns(data: SheetData, sheet: string, required: string[], errors: string[]) {
  const present = headers(data)
  const missing = required.filter((column) => !present.has(column))
  if (missing.length) errors.push(`${sheet}: faltan columnas obligatorias: ${missing.join(', ')}.`)
}

function rowsToRecords(data: SheetData): SheetRecord[] {
  if (!data[0]) return []
  const names = data[0].map((cell) => stringValue(cell).toLocaleLowerCase('es'))
  return data
    .slice(1)
    .filter((row) => row.some((cell) => cell !== null && stringValue(cell) !== ''))
    .map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])))
}

function safeImageFilename(value: string) {
  if (!value) return true
  return !value.includes('\0') && !value.split(/[\\/]/).includes('..') && !/^[\\/]/.test(value)
}

function hasCategorySlug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, '')
    .length > 0
}

export function parseImportSheets(sheets: Record<string, SheetData>): ImportData {
  const errors: string[] = []
  const products: ImportProduct[] = []
  const groups: ImportGroup[] = []
  const options: ImportOption[] = []
  const productsSheet = sheetByName(sheets, 'Productos')
  const groupsSheet = sheetByName(sheets, 'GruposOpciones')
  const optionsSheet = sheetByName(sheets, 'Opciones')

  requireColumns(productsSheet, 'Productos', ['codigo', 'nombre', 'categoria', 'precio'], errors)
  if (groupsSheet.length) requireColumns(groupsSheet, 'GruposOpciones', ['producto_codigo', 'grupo_codigo', 'nombre', 'minimo', 'maximo'], errors)
  if (optionsSheet.length) requireColumns(optionsSheet, 'Opciones', ['grupo_codigo', 'opcion_codigo', 'nombre', 'precio_adicional'], errors)

  rowsToRecords(productsSheet).forEach((row, index) => {
    const rowNumber = index + 2
    const code = stringValue(row.codigo)
    const name = stringValue(row.nombre)
    const category = stringValue(row.categoria)
    const description = stringValue(row.descripcion)
    const basePriceCents = centsValue(row.precio)
    const promotionalPriceInput = stringValue(row.precio_promocional)
    const promotionalPriceCents = promotionalPriceInput
      ? centsValue(row.precio_promocional)
      : null
    const active = booleanValue(row.activo, true)
    const available = booleanValue(row.disponible, true)
    const featured = booleanValue(row.destacado, false)
    const starts = dateValue(row.promocion_desde)
    const ends = dateValue(row.promocion_hasta)
    const imageFilename = stringValue(row.imagen_archivo) || undefined
    const sortOrder = sortOrderValue(row.orden)

    if (!code || !name || !category || basePriceCents === null) {
      errors.push(`Productos fila ${rowNumber}: código, nombre, categoría y precio no negativo son obligatorios.`)
      return
    }
    if (code.length > 80 || name.length > 160 || category.length > 100 || description.length > 2_000) {
      errors.push(`Productos fila ${rowNumber}: uno o más textos superan el largo permitido.`)
      return
    }
    if (!hasCategorySlug(category)) {
      errors.push(`Productos fila ${rowNumber}: la categoría debe contener letras o números.`)
      return
    }
    if (sortOrder === null) {
      errors.push(`Productos fila ${rowNumber}: orden debe ser un entero entre -100000 y 100000.`)
      return
    }
    if (promotionalPriceInput && promotionalPriceCents === null) {
      errors.push(`Productos fila ${rowNumber}: el precio promocional debe ser un importe válido, no negativo y dentro del límite permitido.`)
      return
    }
    if (promotionalPriceCents !== null && (promotionalPriceCents > basePriceCents)) {
      errors.push(`Productos fila ${rowNumber}: el precio promocional no puede superar al precio base.`)
      return
    }
    if ((stringValue(row.promocion_desde) && !starts) || (stringValue(row.promocion_hasta) && !ends) || (starts && ends && starts >= ends)) {
      errors.push(`Productos fila ${rowNumber}: el rango de promoción es inválido.`)
      return
    }
    if (active === null || available === null || featured === null) {
      errors.push(`Productos fila ${rowNumber}: usá sí/no en las columnas booleanas.`)
      return
    }
    if (imageFilename && (!safeImageFilename(imageFilename) || imageFilename.length > 255)) {
      errors.push(`Productos fila ${rowNumber}: imagen_archivo no es un nombre seguro.`)
      return
    }

    products.push({
      code,
      name,
      description,
      category,
      basePriceCents,
      promotionalPriceCents,
      promotionStartsAt: starts,
      promotionEndsAt: ends,
      active,
      available,
      featured,
      sortOrder,
      imageFilename,
    })
  })

  const productCodes = new Set<string>()
  for (const product of products) {
    const key = product.code.toLocaleLowerCase('es')
    if (productCodes.has(key)) errors.push(`Código de producto duplicado: ${product.code}.`)
    productCodes.add(key)
  }

  const groupCodes = new Set<string>()
  rowsToRecords(groupsSheet).forEach((row, index) => {
    const rowNumber = index + 2
    const productCode = stringValue(row.producto_codigo)
    const groupCode = stringValue(row.grupo_codigo)
    const name = stringValue(row.nombre)
    const minimum = numberValue(row.minimo)
    const maximum = numberValue(row.maximo)
    const required = booleanValue(row.obligatorio, false)
    const active = booleanValue(row.activo, true)
    const sortOrder = sortOrderValue(row.orden)
    const key = groupCode.toLocaleLowerCase('es')
    if (!productCode || !groupCode || !name || productCode.length > 80 || groupCode.length > 80 || name.length > 120 || !Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 0 || maximum < Math.max(1, minimum) || maximum > 20 || sortOrder === null) {
      errors.push(`GruposOpciones fila ${rowNumber}: datos o límites inválidos.`)
      return
    }
    if (!productCodes.has(productCode.toLocaleLowerCase('es'))) {
      errors.push(`GruposOpciones fila ${rowNumber}: producto_codigo no existe en el lote.`)
      return
    }
    if (groupCodes.has(key)) {
      errors.push(`GruposOpciones fila ${rowNumber}: grupo_codigo duplicado.`)
      return
    }
    if (required === null || active === null) {
      errors.push(`GruposOpciones fila ${rowNumber}: usá sí/no en las columnas booleanas.`)
      return
    }
    if (required && minimum < 1) {
      errors.push(`GruposOpciones fila ${rowNumber}: un grupo obligatorio debe tener mínimo 1.`)
      return
    }
    groupCodes.add(key)
    groups.push({ productCode, groupCode, name, required, minSelect: minimum, maxSelect: maximum, sortOrder, active })
  })

  const optionCodes = new Set<string>()
  rowsToRecords(optionsSheet).forEach((row, index) => {
    const rowNumber = index + 2
    const groupCode = stringValue(row.grupo_codigo)
    const optionCode = stringValue(row.opcion_codigo)
    const name = stringValue(row.nombre)
    const priceDeltaCents = centsValue(row.precio_adicional)
    const active = booleanValue(row.activo, true)
    const sortOrder = sortOrderValue(row.orden)
    const key = `${groupCode.toLocaleLowerCase('es')}:${optionCode.toLocaleLowerCase('es')}`
    if (!groupCode || !optionCode || !name || groupCode.length > 80 || optionCode.length > 80 || name.length > 120 || priceDeltaCents === null || sortOrder === null || !groupCodes.has(groupCode.toLocaleLowerCase('es'))) {
      errors.push(`Opciones fila ${rowNumber}: grupo, código, nombre o precio no negativo inválido.`)
      return
    }
    if (optionCodes.has(key)) {
      errors.push(`Opciones fila ${rowNumber}: opción duplicada dentro del grupo.`)
      return
    }
    if (active === null) {
      errors.push(`Opciones fila ${rowNumber}: usá sí/no en la columna activo.`)
      return
    }
    optionCodes.add(key)
    options.push({ groupCode, optionCode, name, priceDeltaCents, sortOrder, active })
  })

  if (products.length === 0) errors.push('Productos: agregá al menos una fila válida.')
  if (products.length > 500) errors.push('La importación supera el límite de 500 productos.')
  if (groups.length > 2_500) errors.push('La importación supera el límite de 2.500 grupos.')
  if (options.length > 10_000) errors.push('La importación supera el límite de 10.000 opciones.')
  return { products, groups, options, errors }
}

export function csvRecordsToSheet(records: Record<string, string>[]): SheetData {
  if (records.length === 0) return []
  const names = Object.keys(records[0] ?? {})
  return [names, ...records.map((record) => names.map((name) => record[name] ?? ''))]
}
