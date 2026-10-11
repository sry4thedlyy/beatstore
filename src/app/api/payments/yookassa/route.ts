import { getDatabase } from "@/server/db/connection";
import { handlePaymentNotification } from "@/server/checkout/handler";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handlePaymentNotification(await getDatabase(), request);
}
