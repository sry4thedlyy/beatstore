import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { catalogFailure, handleCatalogRequest } from "@/server/catalog/handler";
export const runtime = "nodejs";
async function respond(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await handleCatalogRequest(
      await getDatabase(),
      await getAuth(),
      request,
      (await context.params).id,
    );
  } catch (error) {
    return catalogFailure(error);
  }
}
export { respond as GET, respond as PATCH, respond as DELETE };
