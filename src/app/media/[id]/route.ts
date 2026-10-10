import { isUuid } from "@/server/catalog/repository";
import { getPublicMedia, parseRange, readLocalMedia } from "@/server/media";

export const runtime = "nodejs";

async function respond(
  request: Request,
  context: { params: Promise<{ id: string }> },
  head: boolean,
) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404 });
  const file = await getPublicMedia(id);
  if (!file) return new Response(null, { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await readLocalMedia(file);
  } catch {
    return new Response(null, { status: 404 });
  }
  const headers = new Headers({
    "Content-Type": file.content_type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${file.checksum}"`,
  });
  if (request.headers.get("if-none-match") === headers.get("ETag"))
    return new Response(null, { status: 304, headers });
  // HEAD has no range semantics. GET supports a single range for browser seeking.
  const rangeHeader = head ? null : request.headers.get("range");
  if (rangeHeader) {
    const range = parseRange(rangeHeader, bytes.length);
    if (!range) {
      headers.set("Content-Range", `bytes */${bytes.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${bytes.length}`,
    );
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(
      new Uint8Array(bytes.subarray(range.start, range.end + 1)),
      { status: 206, headers },
    );
  }
  headers.set("Content-Length", String(bytes.length));
  return new Response(head ? null : new Uint8Array(bytes), { headers });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return respond(request, context, false);
}
export async function HEAD(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return respond(request, context, true);
}
