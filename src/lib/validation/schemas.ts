import { z } from 'zod'

const money = z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(Number)
const nullableMoney = z
  .union([money, z.null()])
  .transform((value) => (value === null ? null : Number(value)))

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function validLocale(value: string) {
  try {
    new Intl.DateTimeFormat(value).format()
    return true
  } catch {
    return false
  }
}

function validCurrency(value: string) {
  try {
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: value }).format(0)
    return true
  } catch {
    return false
  }
}

const optionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  priceDeltaCents: money,
  sortOrder: z.number().int(),
})

const optionGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  required: z.boolean(),
  minSelect: z.number().int().nonnegative(),
  maxSelect: z.number().int().positive(),
  sortOrder: z.number().int(),
  options: z.array(optionSchema),
})

const quantityPriceSchema = z.object({
  quantity: z.number().int().min(2).max(20),
  totalPriceCents: money,
})

const quantityPricesSchema = z.array(quantityPriceSchema).max(19).superRefine((rules, context) => {
  const seen = new Set<number>()
  rules.forEach((rule, index) => {
    if (seen.has(rule.quantity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'quantity'],
        message: 'La cantidad promocional está repetida.',
      })
    }
    seen.add(rule.quantity)
  })
})

const productSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  basePriceCents: money,
  promotionalPriceCents: nullableMoney,
  promotionStartsAt: z.string().nullable(),
  promotionEndsAt: z.string().nullable(),
  imagePath: z.string().nullable(),
  available: z.boolean(),
  featured: z.boolean(),
  sortOrder: z.number().int(),
  quantityPrices: quantityPricesSchema.default([]),
  optionGroups: z.array(optionGroupSchema),
})

export const publicMenuSchema = z.object({
  restaurant: z.object({
    id: z.string().uuid(),
    name: z.string(),
    tradeName: z.string(),
    slug: z.string(),
    description: z.string(),
    whatsappPhone: z.string(),
    address: z.string(),
    city: z.string(),
    timezone: z.string().refine(validTimeZone),
    currencyCode: z.string().length(3).refine(validCurrency),
    locale: z.string().refine(validLocale),
    logoPath: z.string().nullable(),
    coverPath: z.string().nullable(),
    primaryColor: z.string(),
    secondaryColor: z.string(),
    deliveryEnabled: z.boolean(),
    pickupEnabled: z.boolean(),
    minimumOrderCents: money,
    defaultPreparationMinutes: z.number().int(),
    isOpen: z.boolean(),
    nextOpeningAt: z.string().nullable(),
  }),
  categories: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      description: z.string(),
      imagePath: z.string().nullable(),
      sortOrder: z.number().int(),
      products: z.array(productSchema),
    }),
  ),
  businessHours: z.array(
    z.object({
      id: z.string().uuid(),
      dayOfWeek: z.number().int().min(0).max(6),
      slotIndex: z.number().int(),
      opensAt: z.string(),
      closesAt: z.string(),
      spansNextDay: z.boolean(),
    }),
  ),
  specialHours: z.array(
    z.object({
      id: z.string().uuid(),
      date: z.string(),
      isClosed: z.boolean(),
      slotIndex: z.number().int(),
      opensAt: z.string().nullable(),
      closesAt: z.string().nullable(),
      spansNextDay: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  paymentMethods: z.array(
    z.object({
      id: z.string().uuid(),
      code: z.string(),
      name: z.string(),
      description: z.string(),
      adjustmentType: z.enum(['none', 'discount', 'surcharge']),
      adjustmentScope: z.enum(['subtotal', 'shipping', 'total']),
      adjustmentBps: z.number().int(),
      adjustmentFixedCents: money,
      transferAlias: z.string().nullable(),
      accountHolder: z.string().nullable(),
      bankName: z.string().nullable(),
      instructions: z.string().nullable(),
      sortOrder: z.number().int(),
    }),
  ),
  deliveryZones: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      description: z.string(),
      deliveryFeeCents: money,
      minimumOrderCents: money,
      freeShippingFromCents: nullableMoney,
      sortOrder: z.number().int(),
    }),
  ),
})

export const generatedOrderSchema = z.object({
  order: z.object({
    actionId: z.string().uuid(),
    displayNumber: z.string(),
    status: z.enum(['generated', 'whatsapp_opened', 'accepted', 'completed', 'cancelled', 'expired']),
    totalCents: money,
    currencyCode: z.string().length(3),
    createdAt: z.string(),
  }),
  whatsapp: z.object({
    phone: z.string(),
    message: z.string(),
    url: z.string().max(100_000).url().refine((value) => {
      const url = new URL(value)
      return url.origin === 'https://wa.me' && /^\/\d+$/.test(url.pathname)
    }, 'La URL de WhatsApp no es válida.'),
  }),
  clientEventToken: z.string().min(22).max(256).regex(/^[A-Za-z0-9_-]+$/).nullable(),
  clientEventExpiresAt: z.string().optional(),
  idempotentReplay: z.boolean().optional().default(false),
})

export const checkoutSchema = z
  .object({
    customerName: z.string().trim().min(2).max(120),
    customerPhone: z.string().trim().min(8).max(40).refine((value) => {
      let compact = value.normalize('NFKC').replace(/[\s().-]/g, '')
      if (compact.startsWith('00')) compact = `+${compact.slice(2)}`
      if (!compact.startsWith('+')) compact = `+${compact}`
      return /^\+[1-9]\d{7,14}$/.test(compact)
    }, 'Incluí código de país y área.'),
    fulfillmentType: z.enum(['delivery', 'pickup']),
    deliveryZoneId: z.string().uuid().optional().or(z.literal('')),
    address: z.string().trim().max(240).optional(),
    city: z.string().trim().max(120).optional(),
    neighborhood: z.string().trim().max(120).optional(),
    floor: z.string().trim().max(40).optional(),
    apartment: z.string().trim().max(40).optional(),
    reference: z.string().trim().max(240).optional(),
    paymentMethodId: z.string().uuid(),
    notes: z.string().trim().max(1000).optional(),
    website: z.string().max(0).optional(),
  })
  .superRefine((value, context) => {
    if (value.fulfillmentType !== 'delivery') return
    if (!value.deliveryZoneId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveryZoneId'],
        message: 'Elegí una zona de envío.',
      })
    }
    if (!value.address || value.address.length < 5) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Ingresá una dirección completa.',
      })
    }
    if (!value.city || value.city.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['city'],
        message: 'Ingresá la ciudad.',
      })
    }
  })

export type CheckoutValues = z.infer<typeof checkoutSchema>

export const passwordSchema = z
  .string()
  .min(12, 'Usá al menos 12 caracteres.')
  .regex(/[a-z]/, 'Agregá una minúscula.')
  .regex(/[A-Z]/, 'Agregá una mayúscula.')
  .regex(/\d/, 'Agregá un número.')
  .regex(/[^\w\s]/, 'Agregá un símbolo.')

export const relativeReturnToSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !/[\r\n]/.test(value),
    'Ruta de retorno inválida',
  )

export const restaurantCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  tradeName: z.string().trim().min(2).max(120),
  description: z.string().trim().max(800),
  whatsappPhone: z.string().trim().min(8).max(20),
  address: z.string().trim().min(4).max(180),
  city: z.string().trim().min(2).max(100),
  timezone: z.string().trim().min(3).max(64),
  currencyCode: z.string().trim().length(3),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  deliveryEnabled: z.boolean(),
  pickupEnabled: z.boolean(),
  minimumOrderCents: z.number().int().nonnegative(),
  initialDeliveryFeeCents: z.number().int().nonnegative().optional(),
  defaultPreparationMinutes: z.number().int().min(5).max(240),
  adminName: z.string().trim().min(2).max(120),
  adminEmail: z.string().trim().email().max(254),
})

export type RestaurantCreateValues = z.infer<typeof restaurantCreateSchema>
