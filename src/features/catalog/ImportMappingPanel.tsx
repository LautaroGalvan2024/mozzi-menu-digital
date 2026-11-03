import { useMemo, useState } from 'react'
import type { SheetData } from 'read-excel-file/browser'
import { IMPORT_FIELDS, detectImportMapping, type ImportField, type ImportMapping, type ImportNormalization } from '../../lib/import-mapping'
import { applyImportProfile, deleteImportProfile, listImportProfiles, saveImportProfile } from '../../lib/import-profiles'

interface Props {
  sheets: Record<string, SheetData>
  mapping: ImportMapping
  normalized: ImportNormalization
  restaurantId: string
  fileName: string
  matchedProfileName: string | null
  busy: boolean
  onChange: (mapping: ImportMapping) => void
  onContinue: (notice?: string) => Promise<void>
}

const primaryFields = new Set(['codigo', 'nombre', 'categoria', 'precio'])
const columnLetter = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : `${columnLetter(Math.floor(index / 26) - 1)}${columnLetter(index % 26)}`
const cellText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '')
const kindLabels = { product: 'Reconocido', section: 'Categoría', header: 'Encabezado', empty: 'Vacía', ignored: 'Excluida', invalid: 'Revisar' }

export function ImportMappingPanel({ sheets, mapping, normalized, restaurantId, fileName, matchedProfileName, busy, onChange, onContinue }: Props) {
  const [profiles, setProfiles] = useState(() => listImportProfiles(restaurantId))
  const [profileName, setProfileName] = useState(matchedProfileName ?? fileName.replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '').slice(0, 80))
  const [remember, setRemember] = useState(true)
  const [profileMessage, setProfileMessage] = useState('')
  const [selectedProfile, setSelectedProfile] = useState('')
  const [filter, setFilter] = useState<'products' | 'issues' | 'all'>('products')
  const [page, setPage] = useState(0)
  const source = sheets[mapping.sheetName] ?? []
  const columnCount = source.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const header = cellText(source[mapping.headerRow]?.[index]).trim()
    const example = source.slice(mapping.headerRow + 1).find((row) => cellText(row[index]).trim())?.[index]
    return { index, label: `${columnLetter(index)} · ${header || 'Sin título'}`, example: cellText(example).slice(0, 80) }
  })
  const visibleRows = useMemo(() => normalized.rows.filter((row) => filter === 'all' ? row.kind !== 'empty' : filter === 'issues' ? row.issues.length > 0 || row.kind === 'invalid' : row.kind === 'product' || row.kind === 'invalid'), [normalized.rows, filter])
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / 20))
  const activePage = Math.min(page, pageCount - 1)

  function change(next: ImportMapping) {
    setPage(0)
    onChange(next)
  }

  function mapField(field: ImportField, value: string) {
    const next = { ...mapping.columns }
    if (value === '') delete next[field]
    else next[field] = Number(value)
    change({ ...mapping, columns: next })
  }

  function setCategoryColumn(value: string) {
    const next = { ...mapping }
    if (value === '') delete next.categoryColumn
    else next.categoryColumn = Number(value)
    change(next)
  }

  function setCategoryMode(value: ImportMapping['categoryMode']) {
    const columns = { ...mapping.columns }
    if (value !== 'column') delete columns.categoria
    change({ ...mapping, columns, categoryMode: value })
  }

  function fieldControl(field: typeof IMPORT_FIELDS[number]) {
    const column = mapping.columns[field.key]
    const required = 'required' in field && field.required
    const suppliedCategory = field.key === 'categoria' && mapping.categoryMode !== 'column'
    return <label className="field" key={field.key}>
      <span>{field.label}{required ? ' *' : ''}</span>
      <select aria-label={`Columna para ${field.label}`} disabled={busy || suppliedCategory} value={column ?? ''} onChange={(event) => mapField(field.key, event.target.value)}>
        <option value="">{suppliedCategory ? 'Según configuración de categorías' : 'Sin relacionar'}</option>
        {columns.map((item) => <option key={item.index} value={item.index}>{item.label}</option>)}
      </select>
      <p className="text-xs font-normal text-stone-500">{suppliedCategory ? 'Se completa con la regla de categorías.' : column !== undefined ? `Ejemplo: ${columns[column]?.example || 'Vacío'}` : required ? 'Necesitamos este dato para importar.' : 'Se conserva el valor actual al actualizar.'}</p>
    </label>
  }

  async function continueWithMapping() {
    setProfileMessage('')
    let notice = ''
    if (remember && profileName.trim()) {
      try {
        saveImportProfile(restaurantId, profileName.trim(), mapping, sheets)
        setProfiles(listImportProfiles(restaurantId))
        notice = `Guardamos el formato «${profileName.trim()}» para este comercio en este navegador.`
      } catch (failure) {
        // Remembering a format is optional; it must not block a valid import.
        notice = failure instanceof Error ? failure.message : 'No pudimos recordar el formato en este navegador.'
        setProfileMessage(notice)
      }
    }
    await onContinue(notice)
  }

  return <section className="form-card mt-6" aria-labelledby="mapping-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-wider text-orange-700">1 · Reconocer el archivo</p><h2 id="mapping-title" className="mt-1 font-display text-xl font-bold">Relacioná tus columnas</h2><p className="mt-2 max-w-3xl text-sm text-stone-600">Revisá lo que encontramos. Podés cambiar la hoja, los encabezados y qué dato representa cada columna.</p></div>
      <span className="rounded-full bg-stone-100 px-3 py-1 text-sm">{fileName}</span>
    </div>
    {matchedProfileName ? <p className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm" role="status">Reconocimos el formato guardado «{matchedProfileName}». Revisá los datos de esta carga antes de continuar.</p> : null}
    {profiles.length ? <div className="mt-5 flex flex-wrap items-end gap-3"><label className="field min-w-56 flex-1"><span>Formatos guardados en este navegador</span><select disabled={busy} value={selectedProfile} onChange={(event) => {
      const id = event.target.value
      setSelectedProfile(id)
      if (!id) return
      const profile = profiles.find((candidate) => candidate.id === id)
      const next = profile && applyImportProfile(profile, sheets)
      if (!next) { setProfileMessage('Este formato no coincide con los encabezados del archivo. Revisá las columnas y guardá una nueva configuración.'); return }
      setProfileName(profile!.name)
      setProfileMessage(`Aplicamos el formato «${profile!.name}».`)
      change(next)
    }}><option value="">Elegir un formato</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><button className="button-secondary" disabled={busy || !selectedProfile} onClick={() => {
      try { deleteImportProfile(restaurantId, selectedProfile); setProfiles(listImportProfiles(restaurantId)); setSelectedProfile(''); setProfileMessage('Formato eliminado de este navegador.') }
      catch (failure) { setProfileMessage(failure instanceof Error ? failure.message : 'No pudimos eliminar el formato.') }
    }}>Olvidar formato</button></div> : null}
    <div className="mt-5 grid gap-4 sm:grid-cols-3">
      <label className="field"><span>Hoja de productos</span><select disabled={busy} value={mapping.sheetName} onChange={(event) => change(detectImportMapping({ [event.target.value]: sheets[event.target.value]! }))}>{Object.keys(sheets).map((name) => <option key={name}>{name}</option>)}</select></label>
      <label className="field"><span>Fila de encabezados</span><input type="number" min={1} max={Math.max(1, source.length)} disabled={busy} value={mapping.headerRow + 1} onChange={(event) => {
        const row = Number(event.target.value) - 1
        if (Number.isInteger(row) && row >= 0 && row < source.length) change({ ...mapping, headerRow: row, skippedRows: [] })
      }}/></label>
      <label className="field"><span>Formato de precios</span><select disabled={busy} value={mapping.priceFormat} onChange={(event) => change({ ...mapping, priceFormat: event.target.value as ImportMapping['priceFormat'] })}><option value="auto">Detectar y revisar ambigüedades</option><option value="decimal-comma">Coma decimal · 1.234,56</option><option value="decimal-dot">Punto decimal · 1,234.56</option></select></label>
    </div>
    <details className="mt-5 rounded-xl border border-stone-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Ver archivo original y números de fila</summary><div className="mt-3 max-h-80 overflow-auto"><table className="data-table"><thead><tr><th>Fila</th>{columns.map((column) => <th key={column.index}>{columnLetter(column.index)}</th>)}</tr></thead><tbody>{source.slice(Math.max(0, mapping.headerRow - 2), mapping.headerRow + 9).map((row, index) => <tr key={index} className={Math.max(0, mapping.headerRow - 2) + index === mapping.headerRow ? 'bg-orange-50' : ''}><td>{Math.max(0, mapping.headerRow - 2) + index + 1}</td>{columns.map((column) => <td key={column.index} className="max-w-72 break-words">{cellText(row[column.index])}</td>)}</tr>)}</tbody></table></div></details>
    <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{IMPORT_FIELDS.filter((field) => primaryFields.has(field.key)).map(fieldControl)}</div>
    <div className="mt-5 grid gap-4 rounded-xl bg-stone-50 p-4 sm:grid-cols-2">
      <label className="field"><span>Dónde están las categorías</span><select disabled={busy} value={mapping.categoryMode} onChange={(event) => setCategoryMode(event.target.value as ImportMapping['categoryMode'])}><option value="column">Columna por producto</option><option value="section">Títulos entre bloques</option><option value="fixed">Una categoría para todos</option></select></label>
      {mapping.categoryMode === 'section' ? <label className="field"><span>Columna de los títulos de categoría</span><select disabled={busy} value={mapping.categoryColumn ?? ''} onChange={(event) => setCategoryColumn(event.target.value)}><option value="">Seleccionar columna</option>{columns.map((column) => <option key={column.index} value={column.index}>{column.label}</option>)}</select></label> : mapping.categoryMode === 'fixed' ? <label className="field"><span>Categoría para todos los productos</span><input disabled={busy} maxLength={100} value={mapping.fixedCategory} onChange={(event) => change({ ...mapping, fixedCategory: event.target.value })}/></label> : <p className="self-center text-sm text-stone-600">Cada producto toma la categoría de la columna relacionada arriba.</p>}
    </div>
    <details className="mt-5 rounded-xl border border-stone-200 p-4"><summary className="cursor-pointer text-sm font-semibold">Más campos: descripción, promociones, imágenes y variantes</summary><p className="mt-3 text-sm text-stone-600">Los campos sin relacionar conservan su valor actual. Una descripción o promoción relacionada pero vacía puede borrar el valor guardado.</p><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{IMPORT_FIELDS.filter((field) => !primaryFields.has(field.key)).map(fieldControl)}</div></details>
    {normalized.ignoredColumns.length ? <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm"><strong>Columnas que no se importarán</strong><p className="mt-1">{normalized.ignoredColumns.map((index) => columns[index]?.label ?? columnLetter(index)).join(' · ')}</p><p className="mt-2">Podés relacionarlas arriba. Datos como costo o stock todavía no se cargan desde este importador.</p></div> : null}
    <div className="mt-6 grid gap-3 sm:grid-cols-3"><p className="metric-mini"><strong>{normalized.data.products.length}</strong>productos reconocidos</p><p className="metric-mini"><strong>{normalized.categoryCount}</strong>categorías</p><p className="metric-mini"><strong>{normalized.errors.length}</strong>errores por resolver</p></div>
    {normalized.warnings.length ? <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm"><ul className="list-disc space-y-1 pl-5">{normalized.warnings.slice(0, 20).map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
    {normalized.errors.length ? <div className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-900" role="alert"><strong>Revisá estos datos antes de continuar</strong><ul className="mt-2 list-disc space-y-1 pl-5">{normalized.errors.slice(0, 30).map((error, index) => <li key={index}>{error}</li>)}</ul>{normalized.errors.length > 30 ? <p className="mt-2">Hay {normalized.errors.length} errores en total. Usá el filtro de filas para revisarlos.</p> : null}</div> : null}
    <div className="mt-5 flex flex-wrap items-end justify-between gap-3"><label className="field max-w-xs"><span>Filas del archivo</span><select value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setPage(0) }}><option value="products">Productos</option><option value="issues">Filas para revisar</option><option value="all">Todas las filas con datos</option></select></label><p className="text-sm text-stone-500">{normalized.skippedCount} filas fuera de la carga · Las exclusiones sólo se aplican a este archivo.</p></div>
    <div className="mt-3 overflow-x-auto"><table className="data-table"><thead><tr><th>Fila original</th><th>Código</th><th>Nombre / contenido</th><th>Categoría</th><th>Precio</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{visibleRows.slice(activePage * 20, activePage * 20 + 20).map((row) => <tr key={row.sourceRow} className={row.issues.length ? 'bg-red-50/60' : ''}><td>{row.sourceRow}</td><td>{row.values.codigo || '—'}</td><td className="min-w-48 max-w-96 break-words">{row.values.nombre || (source[row.sourceRow - 1] ?? []).map(cellText).filter(Boolean).slice(0, 3).join(' · ')}</td><td>{row.values.categoria || '—'}</td><td className="whitespace-nowrap">{row.values.precio || '—'}</td><td><span>{kindLabels[row.kind]}</span>{row.issues.length ? <ul className="mt-1 min-w-48 text-xs text-red-800">{row.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}</td><td>{['product', 'invalid', 'ignored'].includes(row.kind) ? <button type="button" className="text-sm font-semibold text-orange-700 underline" disabled={busy} onClick={() => change({ ...mapping, skippedRows: mapping.skippedRows.includes(row.sourceRow) ? mapping.skippedRows.filter((number) => number !== row.sourceRow) : [...mapping.skippedRows, row.sourceRow] })}>{mapping.skippedRows.includes(row.sourceRow) ? 'Incluir' : 'Excluir'} fila {row.sourceRow}</button> : '—'}</td></tr>)}</tbody></table>{!visibleRows.length ? <p className="p-4 text-sm text-stone-500">No hay filas para este filtro.</p> : null}</div>
    {pageCount > 1 ? <div className="mt-3 flex items-center justify-end gap-3 text-sm"><button className="button-secondary" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Anterior</button><span>{activePage + 1} / {pageCount}</span><button className="button-secondary" disabled={activePage + 1 >= pageCount} onClick={() => setPage(activePage + 1)}>Siguiente</button></div> : null}
    <div className="mt-6 border-t border-stone-200 pt-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)}/>Recordar este formato para próximas cargas en este navegador</label>{remember ? <label className="field mt-3 max-w-md"><span>Nombre del formato</span><input maxLength={80} disabled={busy} value={profileName} onChange={(event) => setProfileName(event.target.value)}/></label> : null}{profileMessage ? <p className="mt-3 text-sm" role="status">{profileMessage}</p> : null}<button className="button-primary mt-4" disabled={busy || normalized.errors.length > 0 || !normalized.data.products.length} onClick={() => void continueWithMapping()}>{busy ? 'Preparando…' : 'Revisar importación'}</button><p className="mt-2 text-sm text-stone-500">En el siguiente paso confirmás la carga. Todavía no se modifica el catálogo.</p></div>
  </section>
}
