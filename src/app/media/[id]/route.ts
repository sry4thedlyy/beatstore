import { isUuid } from "@/server/catalog/repository";
import { getPublicMedia, mediaResponse } from "@/server/media";

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
  return mediaResponse(request, file, head);
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
