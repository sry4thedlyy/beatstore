import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { handleOrderRequest } from "@/server/checkout/handler";
import { preparePaidResponse } from "@/server/documents/after-payment";
export const runtime = "nodejs";
async function respond(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const db = await getDatabase();
  const response = await handleOrderRequest(
    db,
    await getAuth(),
    request,
    (await context.params).id,
  );
  return request.method === "POST"
    ? preparePaidResponse(response, db)
    : response;
}
export const GET = respond;
export const POST = respond;
