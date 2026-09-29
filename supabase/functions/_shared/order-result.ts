import { ApiError } from "./errors.ts";
import type { CanonicalWhatsappOrder, WhatsappItem } from "./whatsapp.ts";

type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", `Respuesta canónica inválida: ${label}.`);
  }
  return value as JsonRecord;
}

function value(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function text(record: JsonRecord, keys: readonly string[], label: string): string {
  const candidate = value(record, keys);
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", `Respuesta canónica inválida: ${label}.`);
  }
  return candidate;
}

function optionalText(record: JsonRecord, keys: readonly string[]): string | null {
  const candidate = value(record, keys);
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function integer(record: JsonRecord, keys: readonly string[], label: string): number {
  const candidate = value(record, keys);
  const numeric = typeof candidate === "string" && /^\d+$/.test(candidate)
    ? Number(candidate)
    : candidate;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", `Respuesta canónica inválida: ${label}.`);
  }
  return numeric;
}

function bool(record: JsonRecord, keys: readonly string[]): boolean {
  return value(record, keys) === true;
}

function parseItems(root: JsonRecord): WhatsappItem[] {
  const candidate = value(root, ["items", "order_items"]);
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", "El pedido canónico no contiene ítems.");
  }
  return candidate.map((rawItem, itemIndex) => {
    const item = object(rawItem, `items.${itemIndex}`);
    const rawOptions = value(item, ["options", "order_item_options"]);
    const options = Array.isArray(rawOptions)
      ? rawOptions.map((rawOption, optionIndex) => {
        const option = object(rawOption, `items.${itemIndex}.options.${optionIndex}`);
        return {
          name: text(option, ["name", "optionName", "option_name_snapshot"], "option.name"),
          priceDeltaCents: integer(
            option,
            ["priceDeltaCents", "price_delta_cents"],
            "option.priceDeltaCents",
          ),
        };
      })
      : [];
    return {
      name: text(item, ["name", "productName", "product_name_snapshot"], "item.name"),
      quantity: integer(item, ["quantity"], "item.quantity"),
      lineTotalCents: integer(item, ["lineTotalCents", "line_total_cents"], "item.lineTotalCents"),
      notes: optionalText(item, ["notes"]),
      options,
    };
  });
}

export type ParsedOrderResult = {
  canonical: CanonicalWhatsappOrder;
  status: "generated" | "whatsapp_opened" | "accepted" | "completed" | "cancelled" | "expired";
  idempotentReplay: boolean;
};

export function parseOrderRpcMetadata(data: unknown): {
  clientEventTokenStored: boolean;
  clientEventExpiresAt?: string;
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { clientEventTokenStored: false };
  }
  const record = data as JsonRecord;
  if (record.code === "RATE_LIMITED") {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Demasiados intentos. Esperá unos minutos y volvé a intentar.",
    );
  }
  return {
    clientEventTokenStored: record.clientEventTokenStored === true,
    clientEventExpiresAt: typeof record.clientEventExpiresAt === "string"
      ? record.clientEventExpiresAt
      : undefined,
  };
}

export function parseOrderResult(data: unknown): ParsedOrderResult {
  const root = object(data, "root");
  const orderCandidate = value(root, ["order"]);
  const restaurantCandidate = value(root, ["restaurant"]);
  const paymentCandidate = value(root, ["paymentMethod", "payment_method"]);
  const order = orderCandidate ? object(orderCandidate, "order") : root;
  const restaurant = restaurantCandidate ? object(restaurantCandidate, "restaurant") : root;
  const payment = paymentCandidate ? object(paymentCandidate, "paymentMethod") : order;
  const statusValue = text(order, ["status"], "order.status");
  if (
    statusValue !== "generated" && statusValue !== "whatsapp_opened" &&
    statusValue !== "accepted" && statusValue !== "completed" && statusValue !== "cancelled" &&
    statusValue !== "expired"
  ) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", "El estado canónico no es válido.");
  }
  const fulfillment = text(order, ["fulfillmentType", "fulfillment_type"], "order.fulfillmentType");
  if (fulfillment !== "delivery" && fulfillment !== "pickup") {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", "Modalidad canónica inválida.");
  }

  return {
    status: statusValue,
    idempotentReplay: bool(root, ["idempotentReplay", "idempotent_replay"]),
    canonical: {
      actionId: text(order, ["actionId", "action_id"], "order.actionId"),
      displayNumber: text(order, ["displayNumber", "display_number"], "order.displayNumber"),
      createdAt: text(order, ["createdAt", "created_at"], "order.createdAt"),
      restaurantName: text(
        restaurant,
        ["name", "restaurantName", "restaurant_name"],
        "restaurant.name",
      ),
      restaurantTimezone: text(restaurant, [
        "timezone",
        "restaurantTimezone",
        "restaurant_timezone",
      ], "restaurant.timezone"),
      restaurantLocale: text(
        restaurant,
        ["locale", "restaurantLocale", "restaurant_locale"],
        "restaurant.locale",
      ),
      whatsappPhone: text(
        restaurant,
        ["whatsappPhone", "whatsapp_phone_e164"],
        "restaurant.whatsappPhone",
      ),
      customerName: text(order, ["customerName", "customer_name"], "order.customerName"),
      customerPhone: text(order, ["customerPhone", "customer_phone"], "order.customerPhone"),
      fulfillmentType: fulfillment,
      deliveryAddress: optionalText(order, ["deliveryAddress", "delivery_address"]),
      deliveryCity: optionalText(order, ["deliveryCity", "delivery_city"]),
      deliveryNeighborhood: optionalText(order, ["deliveryNeighborhood", "delivery_neighborhood"]),
      deliveryFloor: optionalText(order, ["deliveryFloor", "delivery_floor"]),
      deliveryApartment: optionalText(order, ["deliveryApartment", "delivery_apartment"]),
      deliveryReference: optionalText(order, ["deliveryReference", "delivery_reference"]),
      customerNotes: optionalText(order, ["customerNotes", "customer_notes"]),
      paymentMethodName: text(payment, [
        "name",
        "paymentMethodName",
        "payment_method_name_snapshot",
      ], "payment.name"),
      paymentInstructions: optionalText(payment, [
        "instructions",
        "paymentInstructions",
        "payment_instructions_snapshot",
      ]),
      transferAlias: optionalText(payment, [
        "transferAlias",
        "transfer_alias",
        "transfer_alias_snapshot",
      ]),
      subtotalCents: integer(order, ["subtotalCents", "subtotal_cents"], "order.subtotalCents"),
      discountCents: integer(order, ["discountCents", "discount_cents"], "order.discountCents"),
      surchargeCents: integer(order, ["surchargeCents", "surcharge_cents"], "order.surchargeCents"),
      deliveryFeeCents: integer(
        order,
        ["deliveryFeeCents", "delivery_fee_cents"],
        "order.deliveryFeeCents",
      ),
      totalCents: integer(order, ["totalCents", "total_cents"], "order.totalCents"),
      currencyCode: text(order, ["currencyCode", "currency_code"], "order.currencyCode"),
      items: parseItems(root),
    },
  };
}
