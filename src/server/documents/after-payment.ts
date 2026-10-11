import "server-only";
import type { Database } from "../db/connection";
import { ensureLicenseDocument } from "./service";
export async function preparePaidResponse(response: Response, db: Database) {
  if (response.ok) {
    const order = await response.json();
    if (order.status === "PAID") {
      try {
        await ensureLicenseDocument(order.id, db);
      } catch {
        console.error("Document preparation deferred");
      }
    }
    // Return a fresh body after document preparation, without a retained tee.
    return Response.json(order, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
}
