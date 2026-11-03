import type { SheetData } from 'read-excel-file/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportMapping } from '../lib/import-mapping'
import { applyImportProfile, deleteImportProfile, listImportProfiles, matchImportProfile, saveImportProfile } from '../lib/import-profiles'

const sheets: Record<string, SheetData> = {
  products: [
    ['Reporte'],
    ['Código', 'Nombre', 'Categoría', 'Precio'],
    ['00012', 'Producto privado', 'Accesorios', 100],
  ],
}
const mapping: ImportMapping = {
  sheetName: 'products', headerRow: 1,
  columns: { codigo: 0, nombre: 1, categoria: 2, precio: 3 },
  categoryMode: 'column', fixedCategory: '', priceFormat: 'auto', skippedRows: [3],
}
const key = (restaurantId: string) => `catalog-import-profiles:v1:${restaurantId}`

describe('browser import profiles', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

  it('keeps identities when replacing a named format and isolates commerces', () => {
    const first = saveImportProfile('a', 'Proveedor', mapping, sheets)
    const updated = saveImportProfile('a', ' PROVEEDOR ', { ...mapping, priceFormat: 'decimal-comma' }, sheets)
    expect(updated.id).toBe(first.id)
    expect(listImportProfiles('a')).toEqual([updated])
    expect(listImportProfiles('b')).toEqual([])
    deleteImportProfile('b', first.id)
    expect(listImportProfiles('a')).toHaveLength(1)
    deleteImportProfile('a', first.id)
    expect(listImportProfiles('a')).toEqual([])
  })

  it('persists only configuration and headers, dropping excluded source rows', () => {
    const profile = saveImportProfile('a', 'Proveedor', mapping, sheets)
    expect(profile.mapping.skippedRows).toEqual([])
    expect(applyImportProfile(profile, sheets)?.skippedRows).toEqual([])
    const raw = localStorage.getItem(key('a'))!
    expect(raw).not.toContain('Producto privado')
    expect(raw).not.toContain('00012')
    expect(raw).not.toContain('Accesorios')
    expect(JSON.parse(raw).profiles[0].mapping.skippedRows).toEqual([])
  })

  it('matches the same layout with new products and prices but rejects moved or changed headers', () => {
    const profile = saveImportProfile('a', 'Proveedor', mapping, sheets)
    const next = { products: [sheets.products![0]!, sheets.products![1]!, ['999', 'Otro', 'Cables', 900], ['998', 'Más', 'Cables', 1]] }
    expect(matchImportProfile([profile], next)).toEqual(profile)
    expect(applyImportProfile(profile, { products: [['Reporte'], ['Código', 'Precio', 'Categoría', 'Nombre']] })).toBeNull()
    expect(applyImportProfile(profile, { products: [['Reporte'], ['Código', 'Nombre', 'Categoría', 'Costo']] })).toBeNull()
    expect(applyImportProfile(profile, { other: sheets.products! })).toBeNull()
    expect(applyImportProfile(profile, { products: sheets.products!.slice(1) })).toBeNull()
  })

  it('does not pick between matching profiles that may map differently', () => {
    const one = saveImportProfile('a', 'Uno', mapping, sheets)
    const two = saveImportProfile('a', 'Dos', { ...mapping, priceFormat: 'decimal-comma' }, sheets)
    expect(matchImportProfile([one, two], sheets)).toBeNull()
    expect(applyImportProfile(two, sheets)?.priceFormat).toBe('decimal-comma')
  })

  it('matches grouped reports across category changes but detects moved section columns', () => {
    const grouped: Record<string, SheetData> = { products: [
      ['Código', 'Nombre', null, null, 'Precio'],
      [null, null, 'Accesorios'],
      ['01', 'Uno', null, null, 100],
    ] }
    const sectionMapping: ImportMapping = {
      ...mapping, headerRow: 0, columns: { codigo: 0, nombre: 1, precio: 4 }, categoryMode: 'section', categoryColumn: 2,
    }
    const profile = saveImportProfile('a', 'Agrupado', sectionMapping, grouped)
    expect(profile.signature).not.toContain('accesorios')
    const changed: Record<string, SheetData> = { products: [grouped.products![0]!, [null, null, 'Cables'], ['02', 'Dos', null, null, 200]] }
    expect(applyImportProfile(profile, changed)).not.toBeNull()
    const shifted: Record<string, SheetData> = { products: [grouped.products![0]!, [null, null, null, 'Cables'], ['02', 'Dos', null, null, 200]] }
    expect(applyImportProfile(profile, shifted)).toBeNull()
  })

  it('remembers a single category before the first header, including blank separators', () => {
    const grouped: Record<string, SheetData> = { products: [[null, null, 'Bebidas'], [], ['Nombre', 'Precio'], ['Agua', 100]] }
    const sectionMapping: ImportMapping = {
      ...mapping, headerRow: 2, columns: { nombre: 0, precio: 1 }, categoryMode: 'section', categoryColumn: 2,
    }
    const profile = saveImportProfile('a', 'Una categoría', sectionMapping, grouped)
    expect(listImportProfiles('a')).toEqual([profile])
    expect(applyImportProfile(profile, grouped)).toEqual({ ...sectionMapping, skippedRows: [] })
    expect(applyImportProfile(profile, { products: [[null, null, 'Cables'], [], ['Nombre', 'Precio'], ['Cable USB', 200]] })).not.toBeNull()
    expect(applyImportProfile(profile, { products: [[null, null, null, 'Cables'], [], ['Nombre', 'Precio'], ['Cable USB', 200]] })).toBeNull()
  })

  it.each(['{invalid', '{}', '{"version":2,"profiles":[]}', '{"version":1,"profiles":[{"id":"bad"}]}'])('preserves corrupt or incompatible storage instead of overwriting it: %s', (raw) => {
    localStorage.setItem(key('a'), raw)
    expect(listImportProfiles('a')).toEqual([])
    expect(() => saveImportProfile('a', 'Nuevo', mapping, sheets)).toThrow(/no se pueden leer/)
    expect(() => deleteImportProfile('a', 'anything')).toThrow(/no se pueden leer/)
    expect(localStorage.getItem(key('a'))).toBe(raw)
  })

  it('rejects invalid stored mappings and does not apply a forged profile', () => {
    const profile = saveImportProfile('a', 'Proveedor', mapping, sheets)
    const forged = { ...profile, mapping: { ...profile.mapping, columns: { nombre: -1, precio: 3 } } }
    expect(applyImportProfile(forged, sheets)).toBeNull()
    localStorage.setItem(key('a'), JSON.stringify({ version: 1, profiles: [forged] }))
    expect(listImportProfiles('a')).toEqual([])
    expect(() => saveImportProfile('a', 'Nuevo', mapping, sheets)).toThrow(/no se pueden leer/)
  })

  it('bounds saved formats without removing older ones and permits replacing at the limit', () => {
    for (let i = 0; i < 10; i += 1) saveImportProfile('a', `Formato ${i}`, mapping, sheets)
    expect(() => saveImportProfile('a', 'Formato extra', mapping, sheets)).toThrow(/hasta 10/)
    const id = listImportProfiles('a')[0]!.id
    expect(saveImportProfile('a', 'Formato 0', mapping, sheets).id).toBe(id)
    expect(listImportProfiles('a')).toHaveLength(10)
  })

  it('reports unavailable browser storage without losing saved profiles', () => {
    const original = saveImportProfile('a', 'Proveedor', mapping, sheets)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    expect(() => saveImportProfile('a', 'Otro', mapping, sheets)).toThrow(/Liberá espacio/)
    expect(listImportProfiles('a')).toEqual([original])
    expect(() => deleteImportProfile('a', original.id)).toThrow(/Liberá espacio/)
    expect(listImportProfiles('a')).toEqual([original])
  })

  it('allows manual mapping when reading browser storage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    expect(listImportProfiles('a')).toEqual([])
    expect(() => saveImportProfile('a', 'Proveedor', mapping, sheets)).toThrow(/acceder/)
  })

  it('requires usable headers and a valid field mapping before storing a profile', () => {
    expect(() => saveImportProfile('a', '', mapping, sheets)).toThrow(/nombre/)
    expect(() => saveImportProfile('a', 'Proveedor', { ...mapping, columns: { nombre: 1, precio: 1 } }, sheets)).toThrow(/columnas/)
    expect(() => saveImportProfile('a', 'Proveedor', { ...mapping, headerRow: 20 }, sheets)).toThrow(/encabezados/)
    expect(() => saveImportProfile('a', 'Proveedor', { ...mapping, categoryMode: 'fixed' }, sheets)).toThrow(/categoría/)
    expect(listImportProfiles('a')).toEqual([])
  })
})
