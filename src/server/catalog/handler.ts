import "server-only";
import {
  CatalogError,
  expectedRevision,
  uploadLimits,
  type UploadKind,
} from "../../domain/catalog-editor";
import type { Database } from "../db/connection";
import type { ShopAuth } from "../auth";
import type { CurrentUser } from "../auth/session";
import {
  assertAdministrator,
  createProduct,
  deleteProduct,
  getEditorProduct,
  saveProduct,
} from "./admin";
import { uploadProductFile } from "./uploads";

export async function requestAdministrator(
  request: Request,
  auth: ShopAuth,
  db: Database,
): Promise<CurrentUser> {
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) throw new CatalogError(401, "Войди в аккаунт администратора.");
  const user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role:
      session.user.role === "ADMIN"
        ? ("ADMIN" as const)
        : ("CUSTOMER" as const),
  };
  await assertAdministrator(user, db);
  return user;
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const maximum = 48 * 1024;
  if (Number(request.headers.get("content-length")) > maximum)
    throw new CatalogError(413, "Слишком большой запрос.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CatalogError(415, "Нужен JSON-запрос.");
  const reader = request.body?.getReader();
  if (!reader) throw new CatalogError(400, "Пустой запрос.");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new CatalogError(413, "Слишком большой запрос.");
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid");
    return body as Record<string, unknown>;
  } catch {
    throw new CatalogError(400, "Некорректный JSON-запрос.");
  }
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function catalogFailure(error: unknown): Response {
  if (error instanceof CatalogError)
    return response({ message: error.message }, error.status);
  console.error(
    "Catalog request failed:",
    error instanceof Error ? error.name : "Unknown",
  );
  return response(
    { message: "Не удалось выполнить действие. Попробуй ещё раз." },
    503,
  );
}
export async function handleCatalogRequest(
  db: Database,
  auth: ShopAuth,
  request: Request,
  id?: string,
  kind?: string,
): Promise<Response> {
  try {
    const user = await requestAdministrator(request, auth, db);
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== auth.options.baseURL
    )
      throw new CatalogError(
        403,
        "Запрос должен быть отправлен с сайта магазина.",
      );
    if (request.method === "GET" && id && !kind)
      return response(await getEditorProduct(user, id, db));
    if (request.method === "PUT" && id && kind) {
      if (!Object.hasOwn(uploadLimits, kind))
        throw new CatalogError(404, "Назначение файла не найдено.");
      if (!request.body) throw new CatalogError(400, "Файл не передан.");
      const revisionHeader = request.headers.get("x-product-revision");
      if (!revisionHeader || !/^\d+$/.test(revisionHeader))
        throw new CatalogError(400, "Не указана версия карточки.");
      return response(
        await uploadProductFile(
          user,
          id,
          kind as UploadKind,
          {
            stream: request.body,
            size: request.headers.get("x-file-size"),
            name: request.headers.get("x-file-name"),
            revision: expectedRevision(Number(revisionHeader)),
          },
          db,
        ),
      );
    }
    if (request.method === "POST" && !id && !kind)
      return response(
        await createProduct(user, await jsonBody(request), db),
        201,
      );
    if (request.method === "PATCH" && id && !kind)
      return response(await saveProduct(user, id, await jsonBody(request), db));
    if (request.method === "DELETE" && id && !kind) {
      await deleteProduct(user, id, await jsonBody(request), db);
      return response({ deleted: true });
    }
    throw new CatalogError(405, "Действие недоступно.");
  } catch (error) {
    return catalogFailure(error);
  }
}
