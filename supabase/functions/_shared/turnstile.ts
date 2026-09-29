import { z } from "./deps.ts";
import { ApiError } from "./errors.ts";

const responseSchema = z.object({ success: z.boolean() }).passthrough();

export async function verifyTurnstileIfEnabled(token: string | undefined): Promise<void> {
  if (Deno.env.get("TURNSTILE_ENABLED")?.toLowerCase() !== "true") return;
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY")?.trim();
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY is required when TURNSTILE_ENABLED=true");
  if (!token) throw new ApiError(422, "CAPTCHA_REQUIRED", "Completá la verificación anti-spam.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    form.set("idempotency_key", crypto.randomUUID());
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const parsed = responseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success || !parsed.data.success) {
      throw new ApiError(422, "CAPTCHA_FAILED", "No se pudo validar la verificación anti-spam.");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "CAPTCHA_UNAVAILABLE", "La verificación anti-spam no está disponible.");
  } finally {
    clearTimeout(timeout);
  }
}
