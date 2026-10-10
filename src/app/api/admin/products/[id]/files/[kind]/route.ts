import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { catalogFailure, handleCatalogRequest } from "@/server/catalog/handler";
export const runtime = "nodejs";
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; kind: string }> },
) {
  try {
    const { id, kind } = await context.params;
    return await handleCatalogRequest(
      await getDatabase(),
      await getAuth(),
      request,
      id,
      kind,
    );
  } catch (error) {
    return catalogFailure(error);
  }
}
