import { z } from "./deps.ts";
import { validationError } from "./http.ts";
import {
  normalizeEmail,
  normalizeMultiline,
  normalizePhone,
  normalizeSingleLine,
  normalizeSlug,
  tryNormalizePhone,
} from "./normalize.ts";

const uuid = z.string().uuid();
const cents = z.number().int().min(0).max(1_000_000_000_000);
const sortOrder = z.number().int().min(-100_000).max(100_000);

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validCurrency(value: string): boolean {
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function singleLine(max: number, min = 1) {
  return z.string().max(max).transform(normalizeSingleLine).refine(
    (value) => value.length >= min,
    `Debe contener al menos ${min} caracteres.`,
  );
}

function optionalSingleLine(max: number) {
  return z.string().max(max).transform(normalizeSingleLine).optional();
}

function optionalMultiline(max: number) {
  return z.string().max(max).transform(normalizeMultiline).optional();
}

const phone = z.string().min(8).max(40).refine(
  (value) => tryNormalizePhone(value) !== null,
  "El teléfono debe incluir código de país y área.",
).transform(normalizePhone);

const email = z.string().max(254).email().transform(normalizeEmail);

export const createRestaurantSchema = z.object({
  idempotencyKey: uuid,
  name: singleLine(120, 2),
  slug: z.string().max(100).transform(normalizeSlug).refine(
    (value) => /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value),
    "El slug debe tener entre 3 y 63 caracteres seguros.",
  ),
  tradeName: singleLine(120, 2),
  description: optionalMultiline(1_200).default(""),
  whatsappPhoneE164: phone,
  address: singleLine(240, 2),
  city: singleLine(120, 2),
  timezone: singleLine(64, 3).refine(validTimeZone, "Zona horaria inválida.").default(
    "America/Argentina/Cordoba",
  ),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).refine(
    validCurrency,
    "Moneda inválida.",
  ).default("ARS"),
  locale: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("es-AR"),
  primaryColor: z.string().trim().toUpperCase().regex(/^#[0-9A-F]{6}$/),
  secondaryColor: z.string().trim().toUpperCase().regex(/^#[0-9A-F]{6}$/),
  deliveryEnabled: z.boolean(),
  pickupEnabled: z.boolean(),
  minimumOrderCents: cents,
  initialDeliveryFeeCents: cents.optional(),
  defaultPreparationMinutes: z.number().int().min(5).max(360),
  createBasicPaymentMethods: z.boolean().default(true),
  administrator: z.object({
    fullName: singleLine(120, 2),
    email,
  }).strict(),
}).strict().refine((value) => value.deliveryEnabled || value.pickupEnabled, {
  message: "Debe habilitarse envío o retiro.",
  path: ["deliveryEnabled"],
});

export const inviteRestaurantUserSchema = z.object({
  restaurantId: uuid,
  fullName: singleLine(120, 2),
  email,
  role: z.enum(["restaurant_admin", "order_manager"]),
}).strict();

const orderItemSchema = z.object({
  productId: uuid,
  quantity: z.number().int().min(1).max(100),
  notes: optionalMultiline(500),
  optionIds: z.array(uuid).max(30).refine(
    (values) => new Set(values).size === values.length,
    "No se permiten opciones duplicadas.",
  ),
}).strict();

const fulfillmentSchema = z.object({
  type: z.enum(["delivery", "pickup"]),
  deliveryZoneId: uuid.optional(),
  address: optionalSingleLine(240),
  city: optionalSingleLine(120),
  neighborhood: optionalSingleLine(120),
  floor: optionalSingleLine(40),
  apartment: optionalSingleLine(40),
  reference: optionalMultiline(240),
}).strict().superRefine((value, context) => {
  if (value.type === "delivery") {
    if (!value.deliveryZoneId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryZoneId"],
        message: "Elegí una zona.",
      });
    }
    if (!value.address || value.address.length < 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: "Ingresá la dirección.",
      });
    }
    if (!value.city || value.city.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["city"],
        message: "Ingresá la ciudad.",
      });
    }
  }
});

export const createOrderSchema = z.object({
  restaurantSlug: z.string().max(100).transform(normalizeSlug).refine(
    (value) => /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value),
    "Restaurante inválido.",
  ),
  idempotencyKey: uuid,
  customer: z.object({ name: singleLine(120, 2), phone }).strict(),
  fulfillment: fulfillmentSchema,
  paymentMethodId: uuid,
  notes: optionalMultiline(1_000),
  items: z.array(orderItemSchema).min(1).max(25),
  antiSpam: z.object({
    honeypot: z.string().max(200).optional(),
    formStartedAt: z.string().datetime({ offset: true }),
    turnstileToken: z.string().min(10).max(4_096).optional(),
  }).strict(),
}).strict().refine(
  (value) => value.items.reduce((total, item) => total + item.quantity, 0) <= 100,
  { path: ["items"], message: "La cantidad total de unidades es demasiado grande." },
);

export const registerWhatsappOpenedSchema = z.object({
  actionId: uuid,
  clientEventToken: z.string().min(22).max(256).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const importProductSchema = z.object({
  code: singleLine(80),
  name: singleLine(160),
  description: optionalMultiline(2_000).default(""),
  category: singleLine(100).refine(
    (value) => normalizeSlug(value).length > 0,
    "La categoría debe contener letras o números.",
  ),
  basePriceCents: cents,
  promotionalPriceCents: cents.nullable().optional(),
  promotionStartsAt: z.string().datetime({ offset: true }).nullable().optional(),
  promotionEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
  active: z.boolean().default(true),
  available: z.boolean().default(true),
  featured: z.boolean().default(false),
  sortOrder: sortOrder.default(0),
  imageFilename: optionalSingleLine(255),
}).strict().refine(
  (value) => !value.promotionalPriceCents || value.promotionalPriceCents <= value.basePriceCents,
  {
    path: ["promotionalPriceCents"],
    message: "El precio promocional no puede superar al precio base.",
  },
).refine(
  (value) =>
    !value.promotionStartsAt || !value.promotionEndsAt ||
    value.promotionStartsAt < value.promotionEndsAt,
  { path: ["promotionEndsAt"], message: "El fin de promoción debe ser posterior al inicio." },
);

const importGroupSchema = z.object({
  productCode: singleLine(80),
  groupCode: singleLine(80),
  name: singleLine(120),
  required: z.boolean(),
  minSelect: z.number().int().min(0).max(20),
  maxSelect: z.number().int().min(1).max(20),
  sortOrder: sortOrder.default(0),
  active: z.boolean().default(true),
}).strict().refine((value) => value.maxSelect >= value.minSelect, {
  path: ["maxSelect"],
  message: "El máximo debe ser mayor o igual al mínimo.",
}).refine((value) => !value.required || value.minSelect >= 1, {
  path: ["minSelect"],
  message: "Un grupo obligatorio debe requerir al menos una opción.",
});

const importOptionSchema = z.object({
  groupCode: singleLine(80),
  optionCode: singleLine(80),
  name: singleLine(120),
  priceDeltaCents: cents,
  sortOrder: sortOrder.default(0),
  active: z.boolean().default(true),
}).strict();

export const importProductsSchema = z.object({
  restaurantId: uuid,
  mode: z.enum(["create_or_update", "create_only", "skip_existing"]),
  products: z.array(importProductSchema).min(1).max(500),
  groups: z.array(importGroupSchema).max(2_500).default([]),
  options: z.array(importOptionSchema).max(10_000).default([]),
}).strict().superRefine((value, context) => {
  const productCodes = new Set<string>();
  value.products.forEach((product, index) => {
    const key = product.code.toLocaleLowerCase("en");
    if (productCodes.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["products", index, "code"],
        message: "Código de producto duplicado en la importación.",
      });
    }
    productCodes.add(key);
  });

  const groupCodes = new Set<string>();
  value.groups.forEach((group, index) => {
    const key = group.groupCode.toLocaleLowerCase("en");
    if (!productCodes.has(group.productCode.toLocaleLowerCase("en"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", index, "productCode"],
        message: "El grupo debe referir a un producto incluido en el lote.",
      });
    }
    if (groupCodes.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", index, "groupCode"],
        message: "Código de grupo duplicado en la importación.",
      });
    }
    groupCodes.add(key);
  });

  const optionKeys = new Set<string>();
  value.options.forEach((option, index) => {
    const groupKey = option.groupCode.toLocaleLowerCase("en");
    const optionKey = `${groupKey}:${option.optionCode.toLocaleLowerCase("en")}`;
    if (optionKeys.has(optionKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index, "optionCode"],
        message: "Código de opción duplicado dentro del grupo.",
      });
    }
    if (!groupCodes.has(groupKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index, "groupCode"],
        message: "La opción debe referir a un grupo incluido en el lote.",
      });
    }
    optionKeys.add(optionKey);
  });
});

export const expireOrdersSchema = z.object({
  olderThanMinutes: z.number().int().min(15).max(43_200).default(120),
  limit: z.number().int().min(1).max(5_000).default(500),
}).strict();

export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  return parsed.data;
}
