import "server-only";
import type { Database } from "../db/connection";
import type { ShopAuth } from "../auth";
import type { CurrentUser } from "../auth/session";
import { DeliveryError } from "../../domain/delivery";
import { mediaResponse, localMediaPath, type MediaFile } from "../media";
import { verifyDownload } from "./token";
import {
  getDeliveryView,
  getFreeDownload,
  issueFreeDownload,
  issuePurchaseDownload,
  purchaseAccess,
  resolveDownload,
} from "./service";
import {
  ensureLicenseDocument,
  type DocumentOptions,
} from "../documents/service";
interface HandlerOptions extends DocumentOptions {
  pathForFile?: (file: MediaFile) => string;
}
async function userFrom(
  request: Request,
  auth: ShopAuth,
): Promise<CurrentUser> {
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) throw new DeliveryError(401, "Для скачивания войди в аккаунт.");
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "ADMIN" ? "ADMIN" : "CUSTOMER",
  };
}
async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DeliveryError(415, "Нужен JSON-запрос.");
  const reader = request.body?.getReader();
  if (!reader) throw new DeliveryError(400, "Пустой запрос.");
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (true) {
      const c = await reader.read();
      if (c.done) break;
      n += c.value.length;
      if (n > 8192) {
        await reader.cancel();
        throw new DeliveryError(413, "Слишком большой запрос.");
      }
      chunks.push(c.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new DeliveryError(400, "Некорректный запрос.");
  }
}
export function deliveryJson(v: unknown, status = 200) {
  return Response.json(v, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export function deliveryFailure(e: unknown) {
  return deliveryJson(
    {
      message:
        e instanceof DeliveryError
          ? e.message
          : "Не удалось подготовить скачивание. Повтори попытку позже.",
    },
    e instanceof DeliveryError ? e.status : 503,
  );
}
export async function handleDeliveryRequest(
  db: Database,
  auth: ShopAuth,
  request: Request,
  id: string,
  free = false,
  options: HandlerOptions = {},
) {
  try {
    const user = await userFrom(request, auth);
    if (request.method === "GET")
      return deliveryJson(
        free
          ? await getFreeDownload(user, id, db)
          : await getDeliveryView(user, id, db),
      );
    if (request.method !== "POST")
      throw new DeliveryError(405, "Действие недоступно.");
    if (request.headers.get("origin") !== auth.options.baseURL)
      throw new DeliveryError(
        403,
        "Запрос должен быть отправлен с сайта магазина.",
      );
    const input = await body(request),
      secret = auth.options.secret!;
    if (free)
      return deliveryJson(await issueFreeDownload(user, id, input, db, secret));
    if (input.action === "document" || input.action === "retry-document") {
      const order = await purchaseAccess(user, id, db, true);
      if (order.review || !["PAID", "REFUNDED"].includes(order.status))
        throw new DeliveryError(
          409,
          "Документ для этого состояния заказа недоступен.",
        );
      await ensureLicenseDocument(
        id,
        db,
        options,
        input.action === "retry-document",
      );
      if (input.action === "retry-document")
        return deliveryJson({ prepared: true });
      return deliveryJson(
        await issuePurchaseDownload(user, id, true, db, secret),
      );
    }
    if (input.action === "file")
      return deliveryJson(
        await issuePurchaseDownload(user, id, false, db, secret),
      );
    throw new DeliveryError(400, "Неизвестное действие.");
  } catch (e) {
    return deliveryFailure(e);
  }
}
export async function handleDownloadRequest(
  db: Database,
  auth: ShopAuth,
  request: Request,
  head = false,
  options: HandlerOptions = {},
) {
  try {
    const user = await userFrom(request, auth);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const grant = verifyDownload(token, auth.options.secret!, user.id);
    const file = await resolveDownload(user, grant, db);
    return await mediaResponse(
      request,
      file,
      head,
      true,
      file.original_name,
      options.pathForFile ?? localMediaPath,
      options.storage ?? undefined,
    );
  } catch (e) {
    return deliveryFailure(e);
  }
}
