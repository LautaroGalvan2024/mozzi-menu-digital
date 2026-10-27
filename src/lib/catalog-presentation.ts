import type { PublicProduct } from '../types/domain'

export function groupCatalogProducts(products: readonly PublicProduct[]): PublicProduct[] {
  const groups = new Map<string, PublicProduct>()
  for (const product of products) {
    const key = product.family?.id ?? product.id
    const previous = groups.get(key)
    if (!previous || (!previous.available && product.available)) groups.set(key, product)
  }
  return [...groups.values()]
}

export function productVariants(product: PublicProduct, products: readonly PublicProduct[]): PublicProduct[] {
  return product.family ? products.filter(candidate => candidate.family?.id === product.family!.id) : [product]
}

export function variantLabel(product: PublicProduct): string {
  const attributes = product.variantAttributes ?? {}
  return Object.entries(attributes).map(([name, value]) => `${name}: ${value}`).join(' · ')
}

export function cartProductName(product: PublicProduct): string {
  const variant = variantLabel(product)
  return product.family && variant ? `${product.family.name} · ${variant}`.slice(0, 160) : product.name
}
