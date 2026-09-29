const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const MAX_UPLOAD_BYTES = 1024 * 1024
const TARGET_BYTES = 300 * 1024
const MAX_DIMENSION = 1200

export interface ProcessedImage {
  blob: Blob
  width: number
  height: number
  filename: string
  mimeType: 'image/webp'
}

export function validateImageFile(file: File) {
  if (!ALLOWED_TYPES.has(file.type) || /\.svg$/i.test(file.name)) {
    throw new Error('Usá una imagen JPEG, PNG o WebP. SVG no está permitido.')
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('La imagen original supera el límite de 15 MB.')
  }
  if (file.size === 0) throw new Error('La imagen está vacía.')
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo comprimir la imagen.'))),
      'image/webp',
      quality,
    )
  })
}

export async function processImage(file: File): Promise<ProcessedImage> {
  validateImageFile(file)
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    bitmap.close()
    throw new Error('El navegador no permite procesar esta imagen.')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  let quality = 0.75
  let blob = await canvasToBlob(canvas, quality)
  while (blob.size > TARGET_BYTES && quality > 0.42) {
    quality -= 0.07
    blob = await canvasToBlob(canvas, quality)
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error('No fue posible reducir la imagen por debajo de 1 MB.')
  }
  return {
    blob,
    width,
    height,
    filename: `${crypto.randomUUID()}.webp`,
    mimeType: 'image/webp',
  }
}
