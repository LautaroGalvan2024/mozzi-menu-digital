// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseZipDestination } from '../lib/images/zip-destination'

afterEach(() => vi.unstubAllGlobals())

function savedFile() {
  const parts: Uint8Array<ArrayBuffer>[] = []
  const stream = { write: vi.fn(async (bytes: Uint8Array) => { parts.push(Uint8Array.from(bytes)) }), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) }
  const handle = { createWritable: vi.fn(async () => stream), getFile: vi.fn(async () => new Blob(parts)) }
  return { stream, handle }
}

describe('ZIP download destinations', () => {
  it('opens the native save picker immediately, streams to disk and closes before completion', async () => {
    const { handle, stream } = savedFile()
    const picker = vi.fn(async () => handle)
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    const promise = chooseZipDestination('imagenes.zip')
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'imagenes.zip' }))
    const destination = await promise
    const writer = destination.writable.getWriter()
    await writer.write(new Uint8Array([1, 2]))
    await writer.close()
    expect(stream.write).toHaveBeenCalledWith(new Uint8Array([1, 2]))
    expect(stream.close).toHaveBeenCalledOnce()
    expect(destination.mode).toBe('file')
    expect(await destination.finish()).toBeNull()
  })

  it('uses OPFS without buffering the ZIP, preserves the completed file and only cleans expired exports', async () => {
    const { handle } = savedFile()
    const stale = `export-${Date.now() - 25 * 60 * 60 * 1000}-aaaa.zip`
    const recent = `export-${Date.now()}-bbbb.zip`
    const directory = {
      entries: async function* () { yield [stale, { kind: 'file' }]; yield [recent, { kind: 'file' }]; yield ['unrelated.txt', { kind: 'file' }] },
      removeEntry: vi.fn(async () => undefined),
      getFileHandle: vi.fn(async () => handle),
    }
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }), estimate: async () => ({ quota: 10_000_000, usage: 0 }) } })
    const destination = await chooseZipDestination('imagenes.zip')
    const writer = destination.writable.getWriter()
    await writer.write(new Uint8Array([1, 2, 3]))
    await writer.close()
    expect(destination.mode).toBe('temporary')
    expect(await (await destination.finish())!.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer)
    expect(directory.removeEntry).toHaveBeenCalledTimes(1)
    expect(directory.removeEntry).toHaveBeenCalledWith(stale)
    await destination.abort()
    expect(directory.removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^export-\d+-[a-f0-9-]+\.zip$/))
  })

  it('does not silently switch to memory if local storage is full', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({}) }), estimate: async () => ({ quota: 100, usage: 99 }) } })
    await expect(chooseZipDestination('imagenes.zip')).rejects.toThrow('espacio local')
  })

  it('offers the bounded memory fallback only when file storage is unavailable', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {})
    const destination = await chooseZipDestination('imagenes.zip')
    expect(destination.mode).toBe('memory')
  })

  it('falls back safely on Safari versions that expose OPFS without createWritable', async () => {
    const directory = { getFileHandle: async () => ({}), removeEntry: vi.fn(async () => undefined) }
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } })
    const destination = await chooseZipDestination('imagenes.zip')
    expect(destination.mode).toBe('memory')
    expect(directory.removeEntry).toHaveBeenCalledOnce()
  })

  it('preserves picker cancellation instead of starting an unwanted download', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw new DOMException('cancelled', 'AbortError') } })
    await expect(chooseZipDestination('imagenes.zip')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
