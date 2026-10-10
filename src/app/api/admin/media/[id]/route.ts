import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { catalogFailure, requestAdministrator } from "@/server/catalog/handler";
import { isUuid } from "@/server/catalog/repository";
import { getAdminMedia, mediaResponse } from "@/server/media";
export const runtime = "nodejs";
async function respond(
  request: Request,
  context: { params: Promise<{ id: string }> },
  head: boolean,
) {
  try {
    const db = await getDatabase();
    const user = await requestAdministrator(request, await getAuth(), db);
    const { id } = await context.params;
    if (!isUuid(id)) return new Response(null, { status: 404 });
    const file = await getAdminMedia(user, id, db);
    if (!file) return new Response(null, { status: 404 });
    return mediaResponse(request, file, head, true);
  } catch (error) {
    return catalogFailure(error);
  }
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
