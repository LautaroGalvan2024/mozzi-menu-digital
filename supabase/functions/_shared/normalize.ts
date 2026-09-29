import { ApiError } from "./errors.ts";

function replaceControls(value: string, preserveNewlines: boolean): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (preserveNewlines && code === 10) output += "\n";
    else if (code <= 31 || code === 127) output += " ";
    else output += character;
  }
  return output;
}

export function normalizeSingleLine(value: string): string {
  return replaceControls(value.normalize("NFKC"), false).replace(/\s+/g, " ").trim();
}

export function normalizeMultiline(value: string): string {
  const normalized = replaceControls(value.normalize("NFKC").replace(/\r\n?/g, "\n"), true);
  return normalized
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSlug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function tryNormalizePhone(value: string): string | null {
  let compact = value.normalize("NFKC").trim().replace(/[\s().-]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  if (!compact.startsWith("+")) compact = `+${compact}`;
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
  return compact;
}

export function normalizePhone(value: string): string {
  const normalized = tryNormalizePhone(value);
  if (!normalized) {
    throw new ApiError(422, "INVALID_PHONE", "El teléfono debe incluir código de país y área.");
  }
  return normalized;
}

export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function sanitizeWhatsappText(value: string): string {
  return normalizeSingleLine(value).replace(/[*_~`]/g, "");
}
