import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { catalogFailure, handleCatalogRequest } from "@/server/catalog/handler";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return await handleCatalogRequest(
      await getDatabase(),
      await getAuth(),
      request,
    );
  } catch (error) {
    return catalogFailure(error);
  }
}
