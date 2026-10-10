export type OfferKind = "MP3" | "WAV" | "STEMS" | "EXCLUSIVE" | "DRUMKIT";

export function calculatePrice(
  baseKopecks: number,
  discount: string,
  kind: OfferKind,
): number {
  if (!Number.isSafeInteger(baseKopecks) || baseKopecks <= 0)
    throw new Error("Invalid base price");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(discount))
    throw new Error("Invalid discount");
  const [whole, fraction = ""] = discount.split(".");
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (basisPoints > 10_000) throw new Error("Discount exceeds 100%");
  if (kind === "EXCLUSIVE") return baseKopecks;
  // Integer arithmetic: half a kopeck rounds up, matching PostgreSQL numeric round().
  const price = Number(
    (BigInt(baseKopecks) * BigInt(10_000 - basisPoints) + 5_000n) / 10_000n,
  );
  if (price <= 0) throw new Error("Paid offers must have a positive price");
  return price;
}

export function formatPrice(kopecks: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
  }).format(kopecks / 100);
}

export const offerNames: Record<OfferKind, string> = {
  MP3: "MP3",
  WAV: "WAV",
  STEMS: "TRACKOUT STEMS",
  EXCLUSIVE: "Эксклюзив",
  DRUMKIT: "Драмкит",
};
