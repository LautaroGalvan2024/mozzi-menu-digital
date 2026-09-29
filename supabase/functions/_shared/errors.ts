export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type SafeDatabaseError = {
  status: number;
  code: string;
  message: string;
};

const DATABASE_ERROR_MAP: Readonly<Record<string, SafeDatabaseError>> = {
  ACCOUNT_DISABLED: {
    status: 403,
    code: "ACCOUNT_DISABLED",
    message: "Tu perfil está deshabilitado.",
  },
  RATE_LIMITED: {
    status: 429,
    code: "RATE_LIMITED",
    message: "Demasiados intentos. Esperá unos minutos y volvé a intentar.",
  },
  RESTAURANT_NOT_FOUND: {
    status: 404,
    code: "RESTAURANT_NOT_FOUND",
    message: "El restaurante no está disponible.",
  },
  RESTAURANT_NOT_AVAILABLE: {
    status: 404,
    code: "RESTAURANT_NOT_FOUND",
    message: "El restaurante no está disponible.",
  },
  RESTAURANT_NOT_ACTIVE: {
    status: 409,
    code: "RESTAURANT_NOT_ACTIVE",
    message: "El restaurante no está disponible para recibir pedidos.",
  },
  MENU_NOT_PUBLISHED: {
    status: 409,
    code: "MENU_NOT_PUBLISHED",
    message: "El menú no está publicado.",
  },
  RESTAURANT_CLOSED: {
    status: 409,
    code: "RESTAURANT_CLOSED",
    message: "El restaurante está cerrado en este momento.",
  },
  FULFILLMENT_UNAVAILABLE: {
    status: 422,
    code: "FULFILLMENT_UNAVAILABLE",
    message: "La modalidad elegida no está disponible.",
  },
  DELIVERY_ZONE_INVALID: {
    status: 422,
    code: "DELIVERY_ZONE_INVALID",
    message: "La zona de envío no está disponible.",
  },
  PAYMENT_METHOD_INVALID: {
    status: 422,
    code: "PAYMENT_METHOD_INVALID",
    message: "El medio de pago no está disponible.",
  },
  PRODUCT_UNAVAILABLE: {
    status: 422,
    code: "PRODUCT_UNAVAILABLE",
    message: "Uno de los productos ya no está disponible.",
  },
  OPTION_INVALID: {
    status: 422,
    code: "OPTION_INVALID",
    message: "Una opción seleccionada ya no es válida.",
  },
  OPTION_SELECTION_INVALID: {
    status: 422,
    code: "OPTION_SELECTION_INVALID",
    message: "Revisá las opciones requeridas de los productos.",
  },
  OPTION_GROUP_SELECTION_INVALID: {
    status: 422,
    code: "OPTION_SELECTION_INVALID",
    message: "Revisá las opciones requeridas de los productos.",
  },
  OPTION_NOT_VALID_FOR_PRODUCT: {
    status: 422,
    code: "OPTION_INVALID",
    message: "Una opción seleccionada no corresponde al producto.",
  },
  MINIMUM_ORDER_NOT_MET: {
    status: 422,
    code: "MINIMUM_ORDER_NOT_MET",
    message: "El pedido no alcanza el mínimo requerido.",
  },
  MINIMUM_ORDER_NOT_REACHED: {
    status: 422,
    code: "MINIMUM_ORDER_NOT_MET",
    message: "El pedido no alcanza el mínimo requerido.",
  },
  DELIVERY_ZONE_MINIMUM_NOT_REACHED: {
    status: 422,
    code: "MINIMUM_ORDER_NOT_MET",
    message: "El pedido no alcanza el mínimo de la zona de envío.",
  },
  DELIVERY_DISABLED: {
    status: 422,
    code: "FULFILLMENT_UNAVAILABLE",
    message: "El envío a domicilio no está disponible.",
  },
  PICKUP_DISABLED: {
    status: 422,
    code: "FULFILLMENT_UNAVAILABLE",
    message: "El retiro en el local no está disponible.",
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "La clave de reintento ya fue utilizada para otro pedido.",
  },
  SLUG_ALREADY_EXISTS: {
    status: 409,
    code: "SLUG_ALREADY_EXISTS",
    message: "Ese slug ya está en uso.",
  },
  MEMBERSHIP_NOT_ALLOWED: {
    status: 403,
    code: "FORBIDDEN",
    message: "No tenés permisos para realizar esta acción.",
  },
  SUPER_ADMIN_REQUIRED: {
    status: 403,
    code: "FORBIDDEN",
    message: "No tenés permisos para realizar esta acción.",
  },
  MEMBERSHIP_MANAGEMENT_FORBIDDEN: {
    status: 403,
    code: "FORBIDDEN",
    message: "No tenés permisos para administrar miembros.",
  },
  ROLE_ASSIGNMENT_FORBIDDEN: {
    status: 403,
    code: "FORBIDDEN",
    message: "No tenés permisos para asignar ese rol.",
  },
  CATALOG_IMPORT_FORBIDDEN: {
    status: 403,
    code: "FORBIDDEN",
    message: "No tenés permisos para importar el catálogo.",
  },
  TARGET_USER_INVALID: {
    status: 422,
    code: "TARGET_USER_INVALID",
    message: "El usuario invitado no está disponible.",
  },
  ADMIN_USER_MISMATCH: {
    status: 422,
    code: "ADMIN_USER_MISMATCH",
    message: "No se pudo verificar el usuario administrador.",
  },
  IMPORT_PRODUCT_CODE_EXISTS: {
    status: 409,
    code: "IMPORT_CONFLICT",
    message: "La importación contiene un código de producto que ya existe.",
  },
  IMPORT_PRODUCT_NOT_FOUND: {
    status: 422,
    code: "IMPORT_PRODUCT_NOT_FOUND",
    message: "La importación intenta actualizar un producto inexistente.",
  },
  IMPORT_PAYLOAD_TOO_LARGE: {
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    message: "La importación es demasiado grande.",
  },
  IMPORT_LIMIT_EXCEEDED: {
    status: 422,
    code: "IMPORT_LIMIT_EXCEEDED",
    message: "La importación supera los límites permitidos.",
  },
  IMPORT_MODE_INVALID: {
    status: 422,
    code: "IMPORT_MODE_INVALID",
    message: "El modo de importación no es válido.",
  },
  IMPORT_CATEGORY_INVALID: {
    status: 422,
    code: "IMPORT_CATEGORY_INVALID",
    message: "La importación contiene una categoría inválida.",
  },
  IMPORT_VALUE_INVALID: {
    status: 422,
    code: "IMPORT_VALUE_INVALID",
    message: "La importación contiene valores inválidos.",
  },
  IMPORT_OPTION_GROUP_INVALID: {
    status: 422,
    code: "IMPORT_OPTION_GROUP_INVALID",
    message: "La importación contiene un grupo de opciones inválido.",
  },
  IMPORT_OPTION_INVALID: {
    status: 422,
    code: "IMPORT_OPTION_INVALID",
    message: "La importación contiene una opción inválida.",
  },
  IMPORT_PRODUCT_INVALID: {
    status: 422,
    code: "IMPORT_PRODUCT_INVALID",
    message: "La importación contiene un producto inválido.",
  },
};

type PostgrestErrorLike = {
  code: string;
  message: string;
  details?: string;
  hint?: string;
};

function extractDatabaseCode(error: PostgrestErrorLike): string | undefined {
  const combined = `${error.code} ${error.message} ${error.details ?? ""} ${error.hint ?? ""}`
    .toUpperCase();
  return Object.keys(DATABASE_ERROR_MAP).find((code) => combined.includes(code));
}

export function databaseApiError(error: PostgrestErrorLike): ApiError {
  const safeCode = extractDatabaseCode(error);
  if (safeCode) {
    const mapped = DATABASE_ERROR_MAP[safeCode];
    if (mapped) return new ApiError(mapped.status, mapped.code, mapped.message);
  }
  return new ApiError(500, "DATABASE_ERROR", "No se pudo completar la operación.");
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(500, "INTERNAL_ERROR", "Ocurrió un error inesperado.");
}
