import { ApiError } from "./errors.ts";
import { invalidTokenResponse, oauthProviderFailure } from "./mercadopago-errors.ts";

export type ProviderTransport = (url: string, init: RequestInit) => Promise<Response>;

/** One transport boundary; callers retain responsibility for financial validation. */
export class MercadoPagoClient {
  constructor(
    private readonly transport: ProviderTransport = (url, init) => fetch(url, init),
    private readonly timeoutMs = 10_000,
  ) {}

  async request(
    path: string,
    accessToken?: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid provider path");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.transport(`https://api.mercadopago.com${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        redirect: "error",
      });
    } catch {
      throw new ApiError(
        503,
        "PAYMENT_PROVIDER_UNAVAILABLE",
        "No pudimos contactar a Mercado Pago. Reintentá esta misma compra.",
      );
    }
    if (!response.ok) {
      if (path === "/oauth/token") throw await oauthProviderFailure(response);
      await response.body?.cancel();
      throw new ApiError(
        response.status >= 500 ? 503 : 409,
        "PAYMENT_PROVIDER_ERROR",
        "Mercado Pago no pudo completar la operación. Revisá la conexión del comercio o reintentá.",
      );
    }
    try {
      return await response.json();
    } catch (error) {
      if (path === "/oauth/token") throw invalidTokenResponse(undefined, []);
      throw error;
    }
  }
}
