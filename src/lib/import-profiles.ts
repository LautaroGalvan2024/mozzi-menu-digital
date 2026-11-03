import type { SheetData } from 'read-excel-file/browser'
import { z } from 'zod'
import { IMPORT_FIELDS, normalizeImportHeader, type ImportField, type ImportMapping } from './import-mapping'

export interface ImportProfile {
  id: string
  name: string
  mapping: ImportMapping
  signature: string
  updatedAt: string
}

const MAX_PROFILES = 10
const MAX_STORAGE_LENGTH = 160_000
const storageKey = (restaurantId: string) => `catalog-import-profiles:v1:${restaurantId}`
const columnIndex = z.number().int().min(0).max(16_383)
const fields = IMPORT_FIELDS.map((field) => field.key) as [ImportField, ...ImportField[]]
const mappingSchema = z.object({
  sheetName: z.string().min(1).max(255),
  headerRow: z.number().int().min(0).max(1_048_575),
  columns: z.partialRecord(z.enum(fields), columnIndex),
  categoryMode: z.enum(['column', 'section', 'fixed']),
  categoryColumn: columnIndex.optional(),
  fixedCategory: z.string().max(100),
  priceFormat: z.enum(['auto', 'decimal-comma', 'decimal-dot']),
  skippedRows: z.array(z.number().int()).max(0),
}).strict().superRefine((mapping, context) => {
  if (mapping.columns.nombre === undefined || mapping.columns.precio === undefined) {
    context.addIssue({ code: 'custom', message: 'Seleccioná las columnas de nombre y precio.' })
  }
  if (mapping.categoryMode === 'column' && mapping.columns.categoria === undefined) {
    context.addIssue({ code: 'custom', message: 'Seleccioná la columna de categoría.' })
  }
  if (mapping.categoryMode === 'section' && mapping.categoryColumn === undefined) {
    context.addIssue({ code: 'custom', message: 'Seleccioná la columna de los separadores de categoría.' })
  }
  if (mapping.categoryMode === 'fixed' && !mapping.fixedCategory.trim()) {
    context.addIssue({ code: 'custom', message: 'Completá la categoría fija.' })
  }
  const indexes = Object.values(mapping.columns)
  if (new Set(indexes).size !== indexes.length) {
    context.addIssue({ code: 'custom', message: 'Cada campo debe usar una columna diferente.' })
  }
})
const profileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80).refine((name) => !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)),
  mapping: mappingSchema,
  signature: z.string().min(1).max(12_000),
  updatedAt: z.string().datetime(),
}).strict()
const storeSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema).max(MAX_PROFILES),
}).strict().superRefine((store, context) => {
  const ids = store.profiles.map((profile) => profile.id)
  const names = store.profiles.map((profile) => normalizeImportHeader(profile.name))
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', message: 'Hay formatos guardados repetidos.' })
  }
})

// Parsing deliberately reconstructs the optional property for exact optional types.
function toMapping(mapping: z.infer<typeof mappingSchema>): ImportMapping {
  return {
    sheetName: mapping.sheetName,
    headerRow: mapping.headerRow,
    columns: Object.fromEntries(Object.entries(mapping.columns).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
    categoryMode: mapping.categoryMode,
    ...(mapping.categoryColumn === undefined ? {} : { categoryColumn: mapping.categoryColumn }),
    fixedCategory: mapping.fixedCategory,
    priceFormat: mapping.priceFormat,
    skippedRows: [],
  }
}

function readProfiles(restaurantId: string): ImportProfile[] {
  if (!restaurantId.trim()) throw new Error('Seleccioná un comercio antes de guardar un formato.')
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey(restaurantId))
  } catch {
    throw new Error('No pudimos acceder a los formatos de este navegador. Podés relacionar las columnas sin guardarlos.')
  }
  if (raw === null) return []
  try {
    if (raw.length > MAX_STORAGE_LENGTH) throw new Error('Too large')
    const store = storeSchema.parse(JSON.parse(raw))
    return store.profiles.map((profile) => ({ ...profile, mapping: toMapping(profile.mapping) }))
  } catch {
    // A read-only list can fall back to manual mapping, but writes must not erase a damaged store.
    throw new Error('Los formatos guardados de este comercio no se pueden leer. Podés relacionar las columnas manualmente; no se sobrescribió ningún formato.')
  }
}

export function listImportProfiles(restaurantId: string): ImportProfile[] {
  try { return readProfiles(restaurantId) } catch { return [] }
}

function layoutSignature(mapping: ImportMapping, sheets: Record<string, SheetData>): string | null {
  const sheet = sheets[mapping.sheetName]
  const header = sheet?.[mapping.headerRow]
  if (!header?.length || header.length > 256) return null
  const headers = Array.from(header, normalizeImportHeader)
  const mappedColumns = Object.values(mapping.columns)
  if (mappedColumns.some((index) => index === undefined || !headers[index])) return null
  let sectionColumns: number[] | undefined
  if (mapping.categoryMode === 'section') {
    const positions = new Set<number>()
    const sectionRows = sheet!.slice(mapping.headerRow + 1)
    // Some reports put their first (or only) category immediately before the
    // first header. Include that structural row, skipping blank separators.
    let preceding = mapping.headerRow - 1
    while (preceding >= 0 && !sheet![preceding]?.some((value) => normalizeImportHeader(value))) preceding -= 1
    if (preceding >= 0) sectionRows.push(sheet![preceding]!)
    for (const row of sectionRows) {
      const occupied = Array.from(row, (value, index) => normalizeImportHeader(value) ? index : -1).filter((index) => index >= 0)
      if (occupied.length === 1 && !mappedColumns.includes(occupied[0]!)) positions.add(occupied[0]!)
    }
    sectionColumns = Array.from(positions).sort((a, b) => a - b)
    if (mapping.categoryColumn === undefined || !positions.has(mapping.categoryColumn)) return null
  }
  // Remember only the designated header layout, never product names, prices or row exclusions.
  // Column positions are intentional: a shifted layout must be reviewed again.
  const signature = JSON.stringify({
    sheet: mapping.sheetName,
    headerRow: mapping.headerRow,
    headers,
    categoryMode: mapping.categoryMode,
    categoryColumn: mapping.categoryMode === 'section' ? mapping.categoryColumn : undefined,
    sectionColumns,
  })
  return signature.length <= 12_000 ? signature : null
}

function writeProfiles(restaurantId: string, profiles: ImportProfile[]): void {
  const payload = JSON.stringify(storeSchema.parse({ version: 1, profiles }))
  if (payload.length > MAX_STORAGE_LENGTH) throw new Error('Los formatos ocupan demasiado espacio. Eliminá un formato que ya no uses.')
  try {
    localStorage.setItem(storageKey(restaurantId), payload)
  } catch {
    throw new Error('No pudimos guardar los formatos en este navegador. Liberá espacio o habilitá el almacenamiento; podés importar sin guardar el formato.')
  }
}

export function saveImportProfile(restaurantId: string, name: string, mapping: ImportMapping, sheets: Record<string, SheetData>): ImportProfile {
  const parsedMapping = mappingSchema.safeParse({ ...mapping, skippedRows: [] })
  if (!parsedMapping.success) throw new Error('Revisá las columnas y la categoría antes de guardar el formato.')
  const cleanMapping = toMapping(parsedMapping.data)
  const signature = layoutSignature(cleanMapping, sheets)
  if (!signature) throw new Error('No pudimos reconocer los encabezados de este formato. Revisá la hoja y la fila de encabezados.')
  const profiles = readProfiles(restaurantId)
  const existing = profiles.find((profile) => normalizeImportHeader(profile.name) === normalizeImportHeader(name))
  if (!existing && profiles.length >= MAX_PROFILES) throw new Error('Podés guardar hasta 10 formatos por comercio en este navegador. Eliminá uno para agregar otro.')
  const result = profileSchema.safeParse({
    id: existing?.id ?? crypto.randomUUID(),
    name: name.trim(),
    mapping: cleanMapping,
    signature,
    updatedAt: new Date().toISOString(),
  })
  if (!result.success) throw new Error('Usá un nombre de formato de entre 1 y 80 caracteres, sin saltos de línea.')
  const profile: ImportProfile = { ...result.data, mapping: toMapping(result.data.mapping) }
  writeProfiles(restaurantId, existing ? profiles.map((item) => item.id === profile.id ? profile : item) : [...profiles, profile])
  return profile
}

export function deleteImportProfile(restaurantId: string, id: string): void {
  const profiles = readProfiles(restaurantId)
  if (!profiles.some((profile) => profile.id === id)) return
  writeProfiles(restaurantId, profiles.filter((profile) => profile.id !== id))
}

export function applyImportProfile(profile: ImportProfile, sheets: Record<string, SheetData>): ImportMapping | null {
  const parsed = profileSchema.safeParse(profile)
  if (!parsed.success) return null
  const mapping = toMapping(parsed.data.mapping)
  return layoutSignature(mapping, sheets) === parsed.data.signature ? mapping : null
}

export function matchImportProfile(profiles: ImportProfile[], sheets: Record<string, SheetData>): ImportProfile | null {
  const matches = profiles.filter((profile) => applyImportProfile(profile, sheets) !== null)
  // Multiple compatible profiles may choose different price columns; never choose one silently.
  return matches.length === 1 ? matches[0]! : null
}
