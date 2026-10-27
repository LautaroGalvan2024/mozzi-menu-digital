import { constantTimeEqual, hmacSha256Hex } from "./crypto.ts";
import { ApiError } from "./errors.ts";

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted credential encoding");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

async function credentialKey(encodedKey: string): Promise<CryptoKey> {
  const key = unbase64url(encodedKey);
  if (key.byteLength !== 32) {
    throw new Error("MERCADOPAGO_ENCRYPTION_KEY must encode 32 random bytes");
  }
  return await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Bind ciphertext to its tenant or OAuth state; swapping rows cannot swap credentials.
export async function encryptCredentials(
  value: unknown,
  encodedKey: string,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await credentialKey(encodedKey),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function decryptCredentials(
  value: string,
  encodedKey: string,
  context: string,
): Promise<unknown> {
  const [version, iv, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext || extra) {
    throw new Error("Invalid credential envelope");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unbase64url(iv), additionalData: encoder.encode(context) },
    await credentialKey(encodedKey),
    unbase64url(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function assertCheckoutUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    ![
      "www.mercadopago.com.ar",
      "www.mercadopago.com",
      "sandbox.mercadopago.com.ar",
      "sandbox.mercadopago.com",
    ].includes(url.hostname) || url.username || url.password || url.port
  ) {
    throw new Error("Invalid provider checkout URL");
  }
  return url.href;
}

export function paymentAmountCents(value: number): number {
  const cents = Math.round(value * 100);
  if (
    !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(cents) ||
    Math.abs(value * 100 - cents) > 0.00001
  ) {
    throw new Error("Invalid provider payment amount");
  }
  return cents;
}

export async function verifyPaymentSignature(
  request: Request,
  dataId: string,
  secret: string,
  now = Date.now(),
): Promise<void> {
  const signature = request.headers.get("x-signature") ?? "";
  const requestId = request.headers.get("x-request-id") ?? "";
  const parts = signature.split(",").map((part) => part.trim().split("="));
  const ts = parts.filter(([key]) => key === "ts");
  const v1 = parts.filter(([key]) => key === "v1");
  const timestamp = ts[0]?.[1] ?? "";
  const digest = v1[0]?.[1] ?? "";
  if (
    ts.length !== 1 || v1.length !== 1 || !/^\d{10,13}$/.test(timestamp) ||
    !/^[a-f0-9]{64}$/i.test(digest) || !/^[A-Za-z0-9-]{1,200}$/.test(requestId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(dataId)
  ) {
    throw new ApiError(401, "INVALID_SIGNATURE", "Notificación inválida.");
  }
  const timestampMs = timestamp.length <= 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (Math.abs(now - timestampMs) > 5 * 60_000) {
    throw new ApiError(401, "INVALID_SIGNATURE", "Notificación vencida.");
  }
  const expected = await hmacSha256Hex(
    secret,
    `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`,
  );
  if (!constantTimeEqual(expected, digest.toLowerCase())) {
    throw new ApiError(401, "INVALID_SIGNATURE", "Notificación inválida.");
  }
}
