import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { handleOrderRequest } from "@/server/checkout/handler";
import { preparePaidResponse } from "@/server/documents/after-payment";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const db = await getDatabase();
  return preparePaidResponse(
    await handleOrderRequest(db, await getAuth(), request),
    db,
  );
}
