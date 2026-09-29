export function clientIp(request: Request): string {
  const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare && cloudflare.length <= 64) return cloudflare;

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp && realIp.length <= 64) return realIp;

  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const first = forwarded?.[0];
  return first && first.length <= 64 ? first : "unavailable";
}
