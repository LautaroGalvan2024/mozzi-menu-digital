import {
  Apple,
  Beef,
  Coffee,
  Cookie,
  CookingPot,
  Croissant,
  CupSoda,
  Milk,
  Package,
  PawPrint,
  Scroll,
  ShoppingBasket,
  Snowflake,
  SoapDispenserDroplet,
  SprayCan,
  Wheat,
  Wine,
  type LucideIcon,
} from 'lucide-react'

export const CATEGORY_ICON_KEYS = [
  'basket',
  'pets',
  'drinks',
  'wine',
  'pantry',
  'spices',
  'hygiene',
  'infusions',
  'dairy',
  'cleaning',
  'paper',
  'snacks',
  'produce',
  'meat',
  'bakery',
  'frozen',
  'package',
] as const

export type CategoryIconKey = typeof CATEGORY_ICON_KEYS[number]

export const CATEGORY_ICON_OPTIONS: ReadonlyArray<{
  key: CategoryIconKey
  label: string
  Icon: LucideIcon
}> = [
  { key: 'basket', label: 'Almacén', Icon: ShoppingBasket },
  { key: 'pets', label: 'Mascotas', Icon: PawPrint },
  { key: 'drinks', label: 'Bebidas', Icon: CupSoda },
  { key: 'wine', label: 'Bebidas alcohólicas', Icon: Wine },
  { key: 'pantry', label: 'Granos y harinas', Icon: Wheat },
  { key: 'spices', label: 'Condimentos', Icon: CookingPot },
  { key: 'hygiene', label: 'Higiene personal', Icon: SoapDispenserDroplet },
  { key: 'infusions', label: 'Infusiones', Icon: Coffee },
  { key: 'dairy', label: 'Lácteos', Icon: Milk },
  { key: 'cleaning', label: 'Limpieza', Icon: SprayCan },
  { key: 'paper', label: 'Papeles', Icon: Scroll },
  { key: 'snacks', label: 'Snacks', Icon: Cookie },
  { key: 'produce', label: 'Frutas y verduras', Icon: Apple },
  { key: 'meat', label: 'Carnes', Icon: Beef },
  { key: 'bakery', label: 'Panadería', Icon: Croissant },
  { key: 'frozen', label: 'Congelados', Icon: Snowflake },
  { key: 'package', label: 'General', Icon: Package },
]

const ICONS = Object.fromEntries(CATEGORY_ICON_OPTIONS.map(option => [option.key, option.Icon])) as Record<CategoryIconKey, LucideIcon>

export function isCategoryIconKey(value: unknown): value is CategoryIconKey {
  return typeof value === 'string' && CATEGORY_ICON_KEYS.includes(value as CategoryIconKey)
}

export function inferredCategoryIcon(name: string): CategoryIconKey {
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es')
  if (/animal|mascota|perro|gato|balanceado/.test(normalized)) return 'pets'
  if (/alcohol|cerveza|vino|fernet|licor/.test(normalized)) return 'wine'
  if (/bebida|gaseosa|jugo|agua/.test(normalized)) return 'drinks'
  if (/condimento|especia|salsa/.test(normalized)) return 'spices'
  if (/higiene|cuidado personal|perfumer/.test(normalized)) return 'hygiene'
  if (/infusion|cafe|te\b|yerba|mate/.test(normalized)) return 'infusions'
  if (/lacteo|leche|queso|yogur/.test(normalized)) return 'dairy'
  if (/limpieza|lavandina|detergente/.test(normalized)) return 'cleaning'
  if (/papel|rollo|servilleta|panal/.test(normalized)) return 'paper'
  if (/snack|gallet|golosina|chocolate/.test(normalized)) return 'snacks'
  if (/verdul|verdura|fruta|hortaliza/.test(normalized)) return 'produce'
  if (/carne|pollo|pescado|fiambre/.test(normalized)) return 'meat'
  if (/panader|pan\b|factura/.test(normalized)) return 'bakery'
  if (/congelado|helado/.test(normalized)) return 'frozen'
  if (/harina|arroz|cereal|legumbre/.test(normalized)) return 'pantry'
  if (/almacen|mercaderia|comestible/.test(normalized)) return 'basket'
  return 'package'
}

export function resolvedCategoryIcon(name: string, iconKey?: string | null): CategoryIconKey {
  return isCategoryIconKey(iconKey) ? iconKey : inferredCategoryIcon(name)
}

export function CategoryIconGraphic({ name, iconKey, className }: { name: string; iconKey?: string | null; className?: string }) {
  const key = resolvedCategoryIcon(name, iconKey)
  const Icon = ICONS[key]
  return <Icon className={className} aria-hidden data-category-icon={key} />
}
