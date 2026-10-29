const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const MAX_UPLOAD_BYTES = 1024 * 1024
const VARIANT_TARGETS = [
  { width: 320, targetBytes: 45 * 1024 },
  { width: 640, targetBytes: 120 * 1024 },
  { width: 1200, targetBytes: 300 * 1024 },
] as const

export interface ProcessedImageVariant {
  blob: Blob
  width: number
  height: number
  filename: string
  mimeType: 'image/webp'
}

export interface ProcessedImage extends ProcessedImageVariant {
  variants: ProcessedImageVariant[]
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

async function encodeVariant(
  bitmap: ImageBitmap,
  baseName: string,
  targetWidth: number,
  targetBytes: number,
): Promise<ProcessedImageVariant> {
  // Exact widths keep the generated srcset descriptors truthful.
  const width = targetWidth
  const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('El navegador no permite procesar esta imagen.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)

  let quality = 0.78
  let blob = await canvasToBlob(canvas, quality)
  while (blob.size > targetBytes && quality > 0.43) {
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
    filename: `${baseName}-${targetWidth}.webp`,
    mimeType: 'image/webp',
  }
}

export async function processImage(file: File): Promise<ProcessedImage> {
  validateImageFile(file)
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  if (!bitmap.width || !bitmap.height) {
    bitmap.close()
    throw new Error('La imagen no tiene dimensiones válidas.')
  }
  const baseName = crypto.randomUUID()
  try {
    const variants = []
    for (const target of VARIANT_TARGETS) {
      variants.push(await encodeVariant(bitmap, baseName, target.width, target.targetBytes))
    }
    const primary = variants.at(-1)!
    return { ...primary, variants }
  } finally {
    bitmap.close()
  }
}
