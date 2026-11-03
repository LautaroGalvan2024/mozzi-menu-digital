const MEMORY_LIMIT = 250 * 1024 * 1024
const TEMP_DIRECTORY = 'mozzi-image-exports'
const TEMP_MAX_AGE = 24 * 60 * 60 * 1000

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>
}

export interface ZipDestination {
  mode: 'file' | 'temporary' | 'memory'
  writable: WritableStream<Uint8Array>
  finish: () => Promise<Blob | null>
  abort: () => Promise<void>
}

export function memoryZipDestination(limit = MEMORY_LIMIT): ZipDestination {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let bytes = 0
  return {
    mode: 'memory',
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        bytes += chunk.byteLength
        if (bytes > limit) throw new Error('Este navegador sólo permite preparar hasta 250 MB en memoria. Usá un navegador actualizado con almacenamiento local para descargar el catálogo completo.')
        chunks.push(Uint8Array.from(chunk))
      },
      abort() { chunks.length = 0 },
    }),
    finish: async () => {
      const blob = new Blob(chunks, { type: 'application/zip' })
      chunks.length = 0
      return blob
    },
    abort: async () => { chunks.length = 0 },
  }
}

async function cleanTemporaryExports(directory: FileSystemDirectoryHandle) {
  const iterable = directory as FileSystemDirectoryHandle & { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }
  if (!iterable.entries) return
  for await (const [name, entry] of iterable.entries()) {
    const timestamp = /^export-(\d+)-[a-f0-9-]+\.zip$/.exec(name)?.[1]
    if (entry.kind === 'file' && timestamp && Date.now() - Number(timestamp) > TEMP_MAX_AGE) {
      await directory.removeEntry(name).catch(() => undefined)
    }
  }
}

function fileDestination(handle: FileSystemFileHandle, stream: FileSystemWritableFileStream, temporary?: { directory: FileSystemDirectoryHandle; name: string }): ZipDestination {
  return {
    mode: temporary ? 'temporary' : 'file',
    writable: new WritableStream<Uint8Array>({
      write: chunk => stream.write(Uint8Array.from(chunk)),
      close: () => stream.close(),
      abort: reason => stream.abort(reason),
    }),
    // OPFS files must remain present while the browser consumes the download.
    // Old completed files are removed on the next export, never immediately.
    finish: async () => temporary ? handle.getFile() : null,
    abort: async () => {
      await stream.abort().catch(() => undefined)
      if (temporary) await temporary.directory.removeEntry(temporary.name).catch(() => undefined)
    },
  }
}

/** Invoke directly from the click handler, before awaiting imports/network. */
export async function chooseZipDestination(filename: string): Promise<ZipDestination> {
  const picker = (window as SavePickerWindow).showSaveFilePicker
  if (picker) {
    const handle = await picker.call(window, { suggestedName: filename, types: [{ description: 'Archivo ZIP', accept: { 'application/zip': ['.zip'] } }] })
    return fileDestination(handle, await handle.createWritable())
  }
  if (navigator.storage?.getDirectory) {
    let directory: FileSystemDirectoryHandle
    try {
      const root = await navigator.storage.getDirectory()
      directory = await root.getDirectoryHandle(TEMP_DIRECTORY, { create: true })
    } catch (error) {
      if (error instanceof DOMException && ['SecurityError', 'NotSupportedError'].includes(error.name)) return memoryZipDestination()
      throw error
    }
    await cleanTemporaryExports(directory)
    const estimate = await navigator.storage.estimate?.()
    if (estimate?.quota && estimate.quota - (estimate.usage ?? 0) < 1024 * 1024) throw new Error('No hay espacio local suficiente para preparar el ZIP. Liberá almacenamiento o elegí otro navegador.')
    const name = `export-${Date.now()}-${crypto.randomUUID()}.zip`
    const handle = await directory.getFileHandle(name, { create: true })
    // Older Safari versions expose OPFS handles without asynchronous writes.
    if (typeof handle.createWritable !== 'function') {
      await directory.removeEntry(name).catch(() => undefined)
      return memoryZipDestination()
    }
    try {
      return fileDestination(handle, await handle.createWritable(), { directory, name })
    } catch (error) {
      await directory.removeEntry(name).catch(() => undefined)
      if (error instanceof DOMException && error.name === 'NotSupportedError') return memoryZipDestination()
      throw error
    }
  }
  return memoryZipDestination()
}
