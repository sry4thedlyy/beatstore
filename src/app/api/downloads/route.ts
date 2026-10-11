import { getAuth } from "@/server/auth";
import { getDatabase } from "@/server/db/connection";
import { handleDownloadRequest } from "@/server/delivery/handler";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return handleDownloadRequest(await getDatabase(), await getAuth(), request);
}
export async function HEAD(request: Request) {
  return handleDownloadRequest(
    await getDatabase(),
    await getAuth(),
    request,
    true,
  );
}
