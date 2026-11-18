/** Explicit legacy minutes keep their meaning; omitted options use expires_at. */
export function orderExpirationCutoff(
  input: { olderThanMinutes?: number; expirationMode?: "expires_at" | "legacy_grace" },
  now = Date.now(),
): string {
  const legacy = input.expirationMode === "legacy_grace" || input.olderThanMinutes !== undefined;
  return new Date(now - (legacy ? (input.olderThanMinutes ?? 120) * 60_000 : 0)).toISOString();
}
