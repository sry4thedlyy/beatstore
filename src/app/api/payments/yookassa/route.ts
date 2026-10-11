import { getDatabase } from "@/server/db/connection";
import { handlePaymentNotification } from "@/server/checkout/handler";
import { getPaymentProvider } from "@/server/payments/provider";
import { ensureLicenseDocument } from "@/server/documents/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const db = await getDatabase();
  return handlePaymentNotification(
    db,
    request,
    getPaymentProvider(db),
    undefined,
    (id) => ensureLicenseDocument(id, db),
  );
}
