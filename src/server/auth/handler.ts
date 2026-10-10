import "server-only";
import type { ShopAuth } from "./index";

const POST_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-out",
  "/request-password-reset",
  "/reset-password",
]);
const LIMIT = 8192;
function failure(status: number, code: string): Response {
  return Response.json(
    { code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > LIMIT) return null;
  const reader = request.body?.getReader();
  if (!reader) return "{}";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleAuthRequest(
  auth: ShopAuth,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/auth".length);
  if (!url.pathname.startsWith("/api/auth/")) return failure(404, "NOT_FOUND");
  let forwarded = request;
  if (request.method === "POST") {
    if (!POST_PATHS.has(path)) return failure(404, "NOT_FOUND");
    if (request.headers.get("origin") !== auth.options.baseURL)
      return failure(403, "INVALID_ORIGIN");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return failure(415, "INVALID_CONTENT_TYPE");
    const raw = await readBody(request);
    if (raw === null) return failure(413, "BODY_TOO_LARGE");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return failure(400, "INVALID_INPUT");
      body = parsed as Record<string, unknown>;
    } catch {
      return failure(400, "INVALID_INPUT");
    }
    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : body.email;
    if (typeof email === "string" && email.length > 254)
      return failure(400, "INVALID_EMAIL");
    const payload =
      path === "/sign-up/email"
        ? { email, password: body.password, name: body.name }
        : path === "/sign-in/email"
          ? { email, password: body.password, rememberMe: true }
          : path === "/request-password-reset"
            ? { email, redirectTo: "/reset-password" }
            : path === "/reset-password"
              ? { newPassword: body.newPassword, token: body.token }
              : {};
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    forwarded = new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } else if (request.method === "GET") {
    if (
      path !== "/get-session" &&
      !/^\/reset-password\/[a-zA-Z0-9_-]{1,256}$/.test(path)
    )
      return failure(404, "NOT_FOUND");
    if (path.startsWith("/reset-password/")) {
      url.searchParams.set("callbackURL", "/reset-password");
      forwarded = new Request(url, { headers: request.headers });
    }
  } else return failure(405, "METHOD_NOT_ALLOWED");
  const response = await auth.handler(forwarded);
  const headers = new Headers(response.headers);
  const retryAfter = headers.get("x-retry-after");
  if (response.status === 429 && retryAfter)
    headers.set("Retry-After", retryAfter);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}
