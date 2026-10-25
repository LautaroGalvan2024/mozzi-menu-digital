import type { CartLine, PublicProduct } from '../../types/domain'

export type CartIssue = { code: 'product_missing' | 'product_unavailable' | 'option_missing' | 'group_minimum' | 'group_maximum'; message: string }

/** Validation is a projection: it never removes notes, lines or old selections. */
export function validateCartLine(line: CartLine, product: PublicProduct | undefined): CartIssue[] {
  if (!product) return [{ code: 'product_missing', message: 'Este producto ya no está en el menú. Quitalo del carrito o consultá al comercio.' }]
  const issues: CartIssue[] = []
  if (!product.available) issues.push({ code: 'product_unavailable', message: 'Este producto no está disponible en este momento.' })
  const currentOptions = new Set(product.optionGroups.flatMap(group => group.options.map(option => option.id)))
  for (const option of line.selectedOptions) {
    if (!currentOptions.has(option.id)) issues.push({ code: 'option_missing', message: `La opción «${option.name}» ya no está disponible. Reconfigurá el producto para revisarla.` })
  }
  const selected = new Set(line.selectedOptions.map(option => option.id))
  for (const group of product.optionGroups) {
    const count = group.options.filter(option => selected.has(option.id)).length
    const minimum = Math.max(group.minSelect, group.required ? 1 : 0)
    if (count < minimum) issues.push({ code: 'group_minimum', message: `${group.name}: elegí al menos ${minimum} ${minimum === 1 ? 'opción' : 'opciones'}.` })
    if (count > group.maxSelect) issues.push({ code: 'group_maximum', message: `${group.name}: admite como máximo ${group.maxSelect} ${group.maxSelect === 1 ? 'opción' : 'opciones'}.` })
  }
  return issues
}

export function validateCartLines(lines: readonly CartLine[], products: readonly PublicProduct[]) {
  const byId = new Map(products.map(product => [product.id, product]))
  return new Map(lines.map(line => [line.key, validateCartLine(line, byId.get(line.productId))]))
}
