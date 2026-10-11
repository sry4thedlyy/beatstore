import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { handleDeliveryRequest } from "@/server/delivery/handler";
export const runtime = "nodejs";
async function respond(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleDeliveryRequest(
    await getDatabase(),
    await getAuth(),
    request,
    (await context.params).id,
  );
}
export const GET = respond;
export const POST = respond;
