import Papa from 'papaparse'
import JSZip from 'jszip'
import type { CellValue, SheetData } from 'read-excel-file/browser'
import type { CellObject } from 'xlsx'

export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024
export const IMPORT_FILE_ACCEPT = '.xlsx,.xls,.ods,.csv,.tsv'
export const IMPORT_FILE_FORMATS = 'XLSX, XLS, ODS, CSV o TSV'
export const MAX_SOURCE_ROWS = 20_000
export const MAX_SOURCE_COLUMNS = 200
const MAX_SOURCE_SHEETS = 30
const MAX_SOURCE_CELLS = 1_000_000
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024

async function fileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('No pudimos leer el archivo seleccionado.'))
    reader.readAsArrayBuffer(file)
  })
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Older Windows systems export Spanish CSV files in this encoding.
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function checkDimensions(rows: number, columns: number) {
  if (rows > MAX_SOURCE_ROWS || columns > MAX_SOURCE_COLUMNS) {
    throw new Error(`El archivo supera el límite de lectura de ${MAX_SOURCE_ROWS.toLocaleString('es-AR')} filas o ${MAX_SOURCE_COLUMNS} columnas por hoja.`)
  }
}

function readDelimited(bytes: Uint8Array, extension: string): Record<string, SheetData> {
  const text = decodeText(bytes).replace(/^\uFEFF/, '')
  if (text.includes('\0')) throw new Error('El archivo de texto contiene datos binarios. Exportalo como CSV o TSV.')
  const separatorDirective = /^sep=([;,|\t])\r?\n/i.exec(text)
  const separator = extension === 'tsv' ? '\t' : separatorDirective?.[1] ?? ''
  const content = separatorDirective ? text.slice(separatorDirective[0].length) : text
  const parsed = Papa.parse<string[]>(content, {
    delimiter: separator,
    delimitersToGuess: [',', ';', '\t', '|'],
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    preview: MAX_SOURCE_ROWS + 1,
  })
  const error = parsed.errors.find((issue) => issue.code !== 'UndetectableDelimiter')
  if (error) throw new Error(`No pudimos leer el CSV/TSV${typeof error.row === 'number' ? ` cerca de la fila ${error.row + 1}` : ''}: revisá las comillas y los separadores.`)
  if (parsed.meta.truncated) checkDimensions(MAX_SOURCE_ROWS + 1, 0)
  const rows: SheetData = parsed.data
  // Keep the physical row containing Excel's separator hint in the preview.
  if (separatorDirective) rows.unshift([separatorDirective[0].trim()])
  checkDimensions(rows.length, Math.max(0, ...rows.map((row) => row.length)))
  if (rows.reduce((count, row) => count + row.length, 0) > MAX_SOURCE_CELLS) throw new Error('El archivo contiene demasiadas celdas para revisarlo. Dividilo en archivos más pequeños.')
  return { Productos: rows }
}

function cellValue(cell: CellObject | undefined): CellValue | null {
  if (!cell) return null
  if (cell.f && (cell.v === undefined || cell.v === null)) return '#SIN_VALOR_CALCULADO'
  if (cell.t === 'e') return cell.w || '#ERROR!'
  if (cell.v === undefined || cell.v === null) return null
  if (cell.t === 'n' && typeof cell.v === 'number') {
    // Preserve identifiers displayed with leading zeros without rounding prices
    // through their currency/decimal display formats. Unsafe numbers stay numeric
    // so the mapping layer can reject them when assigned as identifiers.
    if (Number.isSafeInteger(cell.v) && cell.v >= 0 && cell.v < 1e15 && typeof cell.z === 'string' && /^0{2,80}$/.test(cell.z)) {
      return String(cell.v).padStart(cell.z.length, '0')
    }
    return cell.v
  }
  if (cell.v instanceof Date) return Number.isNaN(cell.v.getTime()) ? '#VALUE!' : cell.v.toISOString()
  if (typeof cell.v === 'string' || typeof cell.v === 'boolean') return cell.v
  return String(cell.v)
}

async function checkArchive(bytes: Uint8Array) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return
  const archive = await JSZip.loadAsync(bytes)
  const entries = Object.values(archive.files)
  if (entries.length > 2_000) throw new Error('La planilla contiene demasiados archivos internos. Exportá solamente las hojas de productos.')
  let expanded = 0
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    expanded += size
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('La planilla supera el límite de 64 MB al descomprimirse. Exportá solamente las hojas de productos.')
  }
}

/** Read values only. Formulas, macros, links and document instructions are never executed. */
export async function readImportFile(file: File): Promise<Record<string, SheetData>> {
  if (file.size > MAX_SPREADSHEET_BYTES) throw new Error('El archivo de datos supera el límite de 10 MB.')
  if (file.size === 0) throw new Error('El archivo está vacío.')
  const extension = file.name.split('.').pop()?.toLocaleLowerCase('es') ?? ''
  if (!['xlsx', 'xls', 'ods', 'csv', 'tsv'].includes(extension)) throw new Error(`Formato no compatible. Elegí un archivo ${IMPORT_FILE_FORMATS}.`)
  const bytes = new Uint8Array(await fileBytes(file))
  if (extension === 'csv' || extension === 'tsv') return readDelimited(bytes, extension)
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b
  const compound = bytes[0] === 0xd0 && bytes[1] === 0xcf
  const legacyBiff = bytes[0] === 0x09 && (bytes[1] ?? 255) <= 0x08
  const legacyText = extension === 'xls' && /^\s*(?:<\?xml|<html\b|<!doctype\s+html|<table\b)/i.test(decodeText(bytes.subarray(0, 512)))
  if (!zipped && !compound && !(extension === 'xls' && legacyBiff) && !legacyText) throw new Error('El contenido no corresponde a una planilla Excel u ODS. Si es un archivo de texto, guardalo como CSV o TSV.')
  await checkArchive(bytes)
  // The maintained CE distribution is pinned to the official SheetJS tarball.
  // Loading it on file selection keeps the parser out of the initial route bundle.
  const XLSX = await import('xlsx')
  if (extension === 'xls') {
    const codepages = await import('xlsx/dist/cpexcel.full.mjs')
    XLSX.set_cptable(codepages)
  }
  let workbook: ReturnType<typeof XLSX.read>
  try {
    workbook = XLSX.read(bytes, {
      type: 'array', raw: true, cellDates: true, cellNF: true, cellText: true,
      cellFormula: true, cellHTML: false, bookVBA: false,
      sheetRows: MAX_SOURCE_ROWS + 1, WTF: true,
    })
  } catch {
    throw new Error('No pudimos abrir la planilla. Comprobá que sea un Excel u ODS válido y que no tenga contraseña.')
  }
  if (workbook.SheetNames.length > MAX_SOURCE_SHEETS) throw new Error(`La planilla supera el límite de ${MAX_SOURCE_SHEETS} hojas. Exportá solamente las hojas que necesitás.`)
  const result: Record<string, SheetData> = Object.create(null) as Record<string, SheetData>
  let cellCount = 0
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet || !sheet['!ref']) { result[name] = []; continue }
    const bounds = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'])
    checkDimensions(bounds.e.r + 1, bounds.e.c + 1)
    cellCount += (bounds.e.r + 1) * (bounds.e.c + 1)
    if (cellCount > MAX_SOURCE_CELLS) throw new Error('La planilla contiene demasiadas celdas para revisarla. Exportá solamente las hojas de productos.')
    const rows: SheetData = []
    // Include leading empty rows/columns so mapping and diagnostics use the same
    // row and column coordinates that the merchant sees in the original workbook.
    for (let row = 0; row <= bounds.e.r; row += 1) {
      const cells: (CellValue | null)[] = []
      for (let column = 0; column <= bounds.e.c; column += 1) {
        cells.push(cellValue(sheet[XLSX.utils.encode_cell({ r: row, c: column })] as CellObject | undefined))
      }
      rows.push(cells)
    }
    result[name] = rows
  }
  if (!Object.values(result).some((rows) => rows.some((row) => row.some((value) => value !== null && value !== '')))) throw new Error('La planilla no contiene datos para importar.')
  return result
}
