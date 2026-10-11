import "server-only";
import { CheckoutError } from "../../domain/checkout";
import type { Database } from "../db/connection";
import type { ShopAuth } from "../auth";
import type { CurrentUser } from "../auth/session";
import { getPaymentProvider, type PaymentProvider } from "../payments/provider";
import {
  createOrder,
  getOrder,
  processNotification,
  refreshOrder,
  simulateOrder,
} from "./service";

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CheckoutError(415, "Нужен JSON-запрос.");
  const reader = request.body?.getReader();
  if (!reader) throw new CheckoutError(400, "Пустой запрос.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new CheckoutError(413, "Слишком большой запрос.");
      }
      chunks.push(c.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new CheckoutError(400, "Некорректный запрос.");
  }
}
function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function handleOrderRequest(
  db: Database,
  auth: ShopAuth,
  request: Request,
  id?: string,
  injectedProvider?: PaymentProvider,
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!session) throw new CheckoutError(401, "Войди в аккаунт.");
    const user: CurrentUser = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role === "ADMIN" ? "ADMIN" : "CUSTOMER",
    };
    if (request.method === "GET" && id)
      return json(await getOrder(user, id, db));
    if (request.method !== "POST")
      throw new CheckoutError(405, "Действие недоступно.");
    if (request.headers.get("origin") !== auth.options.baseURL)
      throw new CheckoutError(
        403,
        "Запрос должен быть отправлен с сайта магазина.",
      );
    const input = await body(request),
      provider = injectedProvider ?? getPaymentProvider(db),
      origin = auth.options.baseURL!;
    if (!id)
      return json(await createOrder(user, input, db, provider, origin), 201);
    if (input.action === "refresh")
      return json(await refreshOrder(user, id, db, provider, origin));
    if (input.action === "cancel")
      return json(await refreshOrder(user, id, db, provider, origin, true));
    if (input.action === "demo-success" || input.action === "demo-cancel")
      return json(
        await simulateOrder(
          user,
          id,
          input.action === "demo-success" ? "succeeded" : "canceled",
          db,
          provider,
          origin,
        ),
      );
    throw new CheckoutError(400, "Неизвестное действие.");
  } catch (error) {
    return orderFailure(error);
  }
}
export function orderFailure(error: unknown) {
  if (error instanceof CheckoutError)
    return json({ message: error.message }, error.status);
  console.error(
    "Order request failed:",
    error instanceof Error ? error.name : "Unknown",
  );
  return json(
    { message: "Не удалось проверить оплату. Заказ сохранён; попробуй позже." },
    503,
  );
}
export async function handlePaymentNotification(
  db: Database,
  request: Request,
  provider = getPaymentProvider(db),
  baseURL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000",
  afterCheck?: (orderId: string) => Promise<void>,
) {
  try {
    const id = await processNotification(
      await body(request),
      db,
      provider,
      baseURL,
    );
    if (id && afterCheck) {
      try {
        await afterCheck(id);
      } catch {
        console.error("Document preparation deferred");
      }
    }
    return json({ received: true });
  } catch (error) {
    return orderFailure(error);
  }
}
