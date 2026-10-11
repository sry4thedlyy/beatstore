import type { OfferKind } from "./pricing";

export class CheckoutError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const orderStatusNames = {
  AWAITING_PAYMENT: "Ожидает оплаты",
  PAID: "Оплачен",
  CANCELLED: "Отменён",
  REFUNDED: "Возвращён",
} as const;
export type OrderStatus = keyof typeof orderStatusNames;
export type PaymentProviderName = "DEMO" | "YOOKASSA";
export interface PurchaseSnapshot {
  version: 1;
  demonstration: true;
  product: {
    id: string;
    title: string;
    description: string;
    type: "BEAT" | "DRUMKIT";
    authors: string[];
    bpm: number | null;
    musicalKey: string | null;
    projectRequirements: string | null;
    royalty: string | null;
  };
  buyer: { id: string; email: string; name: string };
  seller: { name: string; email: string };
  terms: {
    id: string;
    version: string;
    body: string;
    parameters: Record<string, unknown>;
  };
  license: {
    kind: OfferKind;
    tracks: number | null;
    streamLimitPerPlatform: number | null;
    royaltyBasis: string | null;
    reporting: string | null;
  };
  file: { id: string; name: string; kind: string; checksum: string };
  price: { base: number; discount: string; total: number; currency: "RUB" };
}
export interface OrderView {
  id: string;
  status: OrderStatus;
  kind: OfferKind;
  total: number;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  snapshot: PurchaseSnapshot;
  payment: {
    provider: PaymentProviderName;
    status: string;
    confirmationUrl: string | null;
    needsReview: boolean;
  } | null;
}
export const LOCAL_PAYMENT_MINUTES = 15;
export function paymentAmount(kopecks: number): string {
  if (!Number.isSafeInteger(kopecks) || kopecks < 1)
    throw new Error("Invalid amount");
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, "0")}`;
}
export function parseProviderAmount(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,8}\.\d{2}$/.test(value))
    throw new CheckoutError(502, "Некорректная сумма платёжного сервиса.");
  const [rubles, cents] = value.split(".");
  const amount = Number(rubles) * 100 + Number(cents);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2147483647)
    throw new CheckoutError(502, "Некорректная сумма платёжного сервиса.");
  return amount;
}
