import { publicAssetUrl } from '../supabase/public-assets'

const RESPONSIVE_PRIMARY = /^(.*)-1200\.webp$/i
const WIDTHS = [320, 640, 1200] as const

/** Returns all objects belonging to a responsive upload, or one legacy path. */
export function assetVariantPaths(path: string): string[] {
  const match = RESPONSIVE_PRIMARY.exec(path)
  return match ? WIDTHS.map((width) => `${match[1]}-${width}.webp`) : [path]
}

export function responsiveAssetUrls(path: string | null): {
  src: string | null
  srcSet?: string
} {
  if (!path) return { src: null }
  const paths = assetVariantPaths(path)
  if (paths.length === 1) return { src: publicAssetUrl(path) }
  const urls = paths.map((variantPath) => publicAssetUrl(variantPath))
  if (urls.some((url) => !url)) return { src: publicAssetUrl(path) }
  return {
    src: urls[1]!,
    srcSet: urls.map((url, index) => `${url} ${WIDTHS[index]!}w`).join(', '),
  }
}
