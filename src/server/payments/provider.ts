import "server-only";
import {
  CheckoutError,
  paymentAmount,
  parseProviderAmount,
  type PaymentProviderName,
} from "../../domain/checkout";
import { isUuid } from "../catalog/repository";
import type { Database } from "../db/connection";
import { readAuthConfig } from "../auth/config";

export interface PaymentIntent {
  id: string;
  orderId: string;
  key: string;
  amount: number;
  description: string;
  returnUrl: string;
  expiresAt: string;
}
export interface ProviderPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  test: boolean;
  amount: number;
  currency: string;
  orderId: string;
  attemptId: string;
  confirmationUrl: string | null;
}
export interface PaymentProvider {
  name: PaymentProviderName;
  create(intent: PaymentIntent): Promise<ProviderPayment>;
  get(id: string): Promise<ProviderPayment>;
  cancel(id: string): Promise<ProviderPayment>;
  simulate?(id: string, outcome: "succeeded" | "canceled"): Promise<void>;
}
export function paymentConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const { baseURL } = readAuthConfig(env);
  const mode = env.PAYMENT_PROVIDER ?? "demo";
  if (mode === "demo") return { name: "DEMO" as const, baseURL };
  if (mode !== "yookassa")
    throw new Error("PAYMENT_PROVIDER must be demo or yookassa.");
  const shopId = env.YOOKASSA_SHOP_ID,
    secret = env.YOOKASSA_SECRET_KEY;
  if (!shopId || !/^\d+$/.test(shopId) || !secret?.startsWith("test_"))
    throw new Error("Use a YooKassa test shop and a test_ secret key.");
  return { name: "YOOKASSA" as const, baseURL, shopId, secret };
}
export function createDemoProvider(db: Database): PaymentProvider {
  async function get(id: string): Promise<ProviderPayment> {
    if (!isUuid(id)) throw new CheckoutError(404, "Платёж не найден.");
    const { rows } = await db.query<{
      id: string;
      order_id: string;
      amount_kopecks: number;
      status: ProviderPayment["status"];
    }>(
      `UPDATE demo_provider_payments SET status=CASE WHEN status='pending' AND expires_at<=now() THEN 'canceled' ELSE status END WHERE id=$1 RETURNING *`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new CheckoutError(404, "Платёж не найден.");
    return {
      id: row.id,
      status: row.status,
      paid: row.status === "succeeded",
      test: true,
      amount: row.amount_kopecks,
      currency: "RUB",
      orderId: row.order_id,
      attemptId: row.id,
      confirmationUrl: null,
    };
  }
  return {
    name: "DEMO",
    get,
    async create(intent) {
      await db.query(
        `INSERT INTO demo_provider_payments (id,idempotency_key,order_id,amount_kopecks,expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          intent.id,
          intent.key,
          intent.orderId,
          intent.amount,
          intent.expiresAt,
        ],
      );
      return get(intent.id);
    },
    async cancel(id) {
      await this.simulate!(id, "canceled");
      return get(id);
    },
    async simulate(id, outcome) {
      await db.query(
        `UPDATE demo_provider_payments SET status=CASE WHEN expires_at<=now() THEN 'canceled' ELSE $2 END WHERE id=$1 AND status='pending'`,
        [id, outcome],
      );
    },
  };
}
export function createYooKassaProvider(
  shopId: string,
  secret: string,
  transport: typeof fetch = fetch,
): PaymentProvider {
  if (!/^\d+$/.test(shopId) || !secret.startsWith("test_"))
    throw new Error("Only YooKassa test credentials are supported.");
  async function request(
    endpoint: string,
    body?: unknown,
    key?: string,
  ): Promise<ProviderPayment> {
    const response = await transport(
      `https://api.yookassa.ru/v3/payments${endpoint}`,
      {
        method: body ? "POST" : "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${shopId}:${secret}`).toString("base64")}`,
          ...(body
            ? { "Content-Type": "application/json", "Idempotence-Key": key! }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok)
      throw new CheckoutError(
        503,
        "Платёжный сервис временно недоступен. Проверь статус позже.",
      );
    const value = (await response.json()) as Record<string, unknown>;
    const amount = value.amount as
      { value?: unknown; currency?: unknown } | undefined;
    const metadata = value.metadata as Record<string, unknown> | undefined;
    const recipient = value.recipient as { account_id?: unknown } | undefined;
    if (
      typeof value.id !== "string" ||
      !isUuid(value.id) ||
      !["pending", "waiting_for_capture", "succeeded", "canceled"].includes(
        String(value.status),
      ) ||
      !amount ||
      typeof value.paid !== "boolean" ||
      value.test !== true ||
      recipient?.account_id !== shopId ||
      !isUuid(String(metadata?.order_id)) ||
      !isUuid(String(metadata?.payment_id))
    )
      throw new CheckoutError(502, "Платёж требует проверки. Товар не выдан.");
    const confirmation = value.confirmation as
      { type?: unknown; confirmation_url?: unknown } | undefined;
    let url: string | null = null;
    if (confirmation?.confirmation_url) {
      const parsed = new URL(String(confirmation.confirmation_url));
      if (
        confirmation.type !== "redirect" ||
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        !["yoomoney.ru", "yookassa.ru"].some(
          (domain) =>
            parsed.hostname === domain ||
            parsed.hostname.endsWith(`.${domain}`),
        )
      )
        throw new CheckoutError(502, "Некорректный адрес оплаты.");
      url = parsed.href;
    }
    return {
      id: value.id,
      status: value.status as ProviderPayment["status"],
      test: true,
      paid: value.paid,
      amount: parseProviderAmount(amount.value),
      currency: String(amount.currency),
      orderId: String(metadata!.order_id),
      attemptId: String(metadata!.payment_id),
      confirmationUrl: url,
    };
  }
  return {
    name: "YOOKASSA",
    create: (intent) =>
      request(
        "",
        {
          amount: { value: paymentAmount(intent.amount), currency: "RUB" },
          capture: true,
          confirmation: { type: "redirect", return_url: intent.returnUrl },
          description: intent.description.slice(0, 128),
          metadata: { order_id: intent.orderId, payment_id: intent.id },
        },
        intent.key,
      ),
    get: (id) => {
      if (!isUuid(id)) throw new CheckoutError(404, "Платёж не найден.");
      return request(`/${id}`);
    },
    async cancel(id) {
      const current = await this.get(id);
      // YooKassa does not allow merchant cancellation of a pending redirect payment.
      return current.status === "waiting_for_capture"
        ? request(`/${id}/cancel`, {}, `cancel-${id}`)
        : current;
    },
  };
}
export function getPaymentProvider(db: Database): PaymentProvider {
  const config = paymentConfig();
  return config.name === "DEMO"
    ? createDemoProvider(db)
    : createYooKassaProvider(config.shopId, config.secret);
}
