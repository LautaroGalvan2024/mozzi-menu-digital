import { ApiError } from "./errors.ts";
import { sanitizeWhatsappText, tryNormalizePhone } from "./normalize.ts";

export type WhatsappOption = { name: string; priceDeltaCents?: number };
export type WhatsappItem = {
  name: string;
  quantity: number;
  lineTotalCents: number;
  notes?: string | null;
  options: readonly WhatsappOption[];
};

export type CanonicalWhatsappOrder = {
  actionId: string;
  displayNumber: string;
  createdAt: string;
  restaurantName: string;
  restaurantTimezone: string;
  restaurantLocale: string;
  whatsappPhone: string;
  customerName: string;
  customerPhone: string;
  fulfillmentType: "delivery" | "pickup";
  deliveryAddress?: string | null;
  deliveryCity?: string | null;
  deliveryNeighborhood?: string | null;
  deliveryFloor?: string | null;
  deliveryApartment?: string | null;
  deliveryReference?: string | null;
  customerNotes?: string | null;
  paymentMethodName: string;
  paymentInstructions?: string | null;
  transferAlias?: string | null;
  subtotalCents: number;
  discountCents: number;
  surchargeCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currencyCode: string;
  items: readonly WhatsappItem[];
};

function money(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function localDate(isoDate: string, timezone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(isoDate));
  } catch {
    return new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "UTC",
    })
      .format(new Date(isoDate));
  }
}

function addressLines(order: CanonicalWhatsappOrder): string[] {
  if (order.fulfillmentType === "pickup") return ["Retiro en el local"];
  const main = [order.deliveryAddress, order.deliveryCity].filter(Boolean).map((value) =>
    sanitizeWhatsappText(value ?? "")
  );
  const lines = [`Envío a domicilio`, `Dirección: ${main.join(", ")}`];
  if (order.deliveryNeighborhood) {
    lines.push(`Barrio: ${sanitizeWhatsappText(order.deliveryNeighborhood)}`);
  }
  const unit = [
    order.deliveryFloor && `Piso ${sanitizeWhatsappText(order.deliveryFloor)}`,
    order.deliveryApartment && `Dto. ${sanitizeWhatsappText(order.deliveryApartment)}`,
  ]
    .filter(Boolean).join(" · ");
  if (unit) lines.push(unit);
  if (order.deliveryReference) {
    lines.push(`Referencia: ${sanitizeWhatsappText(order.deliveryReference)}`);
  }
  return lines;
}

export function buildWhatsapp(order: CanonicalWhatsappOrder, appBaseUrl: string): {
  phone: string;
  message: string;
  url: string;
  claimUrl: string;
} {
  const normalizedPhone = tryNormalizePhone(order.whatsappPhone);
  if (!normalizedPhone) {
    throw new ApiError(
      500,
      "INVALID_RESTAURANT_PHONE",
      "El restaurante no tiene un WhatsApp válido.",
    );
  }
  const claimUrl = `${appBaseUrl.replace(/\/$/, "")}/admin/pedidos/tomar/${order.actionId}`;
  const lines = [
    `*NUEVO PEDIDO ${sanitizeWhatsappText(order.displayNumber)}*`,
    localDate(order.createdAt, order.restaurantTimezone, order.restaurantLocale),
    "",
    `*${sanitizeWhatsappText(order.restaurantName)}*`,
    "",
    "*Cliente*",
    sanitizeWhatsappText(order.customerName),
    `Teléfono: ${sanitizeWhatsappText(order.customerPhone)}`,
    "",
    "*Modalidad*",
    ...addressLines(order),
    "",
    "*Pedido*",
  ];

  for (const item of order.items) {
    lines.push(`${item.quantity} x ${sanitizeWhatsappText(item.name)}`);
    for (const option of item.options) lines.push(`  - ${sanitizeWhatsappText(option.name)}`);
    if (item.notes) lines.push(`  Nota: ${sanitizeWhatsappText(item.notes)}`);
    lines.push(`  ${money(item.lineTotalCents, order.currencyCode, order.restaurantLocale)}`);
  }

  lines.push(
    "",
    `Subtotal: ${money(order.subtotalCents, order.currencyCode, order.restaurantLocale)}`,
  );
  if (order.discountCents > 0) {
    lines.push(
      `Descuento: -${money(order.discountCents, order.currencyCode, order.restaurantLocale)}`,
    );
  }
  if (order.surchargeCents > 0) {
    lines.push(
      `Recargo: ${money(order.surchargeCents, order.currencyCode, order.restaurantLocale)}`,
    );
  }
  lines.push(
    `Envío: ${
      order.deliveryFeeCents === 0
        ? "Sin cargo"
        : money(order.deliveryFeeCents, order.currencyCode, order.restaurantLocale)
    }`,
  );
  lines.push("", `*TOTAL: ${money(order.totalCents, order.currencyCode, order.restaurantLocale)}*`);
  lines.push("", `Medio de pago: ${sanitizeWhatsappText(order.paymentMethodName)}`);
  if (order.transferAlias) lines.push(`Alias: ${sanitizeWhatsappText(order.transferAlias)}`);
  if (order.paymentInstructions) lines.push(sanitizeWhatsappText(order.paymentInstructions));
  if (order.customerNotes) {
    lines.push("", "Observaciones:", sanitizeWhatsappText(order.customerNotes));
  }
  lines.push("", "✅ *TOMAR PEDIDO*", claimUrl);

  const message = lines.join("\n");
  return {
    phone: normalizedPhone,
    message,
    url: `https://wa.me/${normalizedPhone.slice(1)}?text=${encodeURIComponent(message)}`,
    claimUrl,
  };
}
