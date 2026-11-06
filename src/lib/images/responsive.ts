import { publicAssetUrl } from '../supabase/public-assets'

const RESPONSIVE_PRIMARY = /^(.*)-1200\.webp$/i
const BOUNDED_PRIMARY = /^(.*)-w(\d+)-(\d+)\.webp$/i
const WIDTHS = [320, 640, 1200] as const

function responsiveVariants(path: string): { path: string; width: number }[] | null {
  const bounded = BOUNDED_PRIMARY.exec(path)
  if (bounded) {
    const maxWidth = Number(bounded[2])
    if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 1200 || Number(bounded[3]) !== maxWidth) return null
    return [...new Set(WIDTHS.map(width => Math.min(width, maxWidth)))].map(width => ({
      path: `${bounded[1]}-w${bounded[2]}-${width}.webp`, width,
    }))
  }
  const legacy = RESPONSIVE_PRIMARY.exec(path)
  return legacy ? WIDTHS.map(width => ({ path: `${legacy[1]}-${width}.webp`, width })) : null
}

/** Returns all objects belonging to a responsive upload, or one legacy path. */
export function assetVariantPaths(path: string): string[] {
  return responsiveVariants(path)?.map(variant => variant.path) ?? [path]
}

export function responsiveAssetUrls(path: string | null): {
  src: string | null
  srcSet?: string
} {
  if (!path) return { src: null }
  const variants = responsiveVariants(path)
  if (!variants || variants.length === 1) return { src: publicAssetUrl(path) }
  const urls = variants.map(variant => publicAssetUrl(variant.path))
  if (urls.some((url) => !url)) return { src: publicAssetUrl(path) }
  return {
    src: urls[1]!,
    srcSet: urls.map((url, index) => `${url} ${variants[index]!.width}w`).join(', '),
  }
}
