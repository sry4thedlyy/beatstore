import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { handleOrderRequest } from "@/server/checkout/handler";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handleOrderRequest(await getDatabase(), await getAuth(), request);
}
