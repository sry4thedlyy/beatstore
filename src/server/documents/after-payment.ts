import "server-only";
import type { Database } from "../db/connection";
import { ensureLicenseDocument } from "./service";
export async function preparePaidResponse(response: Response, db: Database) {
  if (response.ok) {
    const order = await response.clone().json();
    if (order.status === "PAID") {
      try {
        await ensureLicenseDocument(order.id, db);
      } catch {
        console.error("Document preparation deferred");
      }
    }
  }
  return response;
}
