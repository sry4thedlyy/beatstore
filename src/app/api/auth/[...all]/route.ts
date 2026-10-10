import { getAuth } from "@/server/auth";
import { handleAuthRequest } from "@/server/auth/handler";
export const runtime = "nodejs";

async function handle(request: Request) {
  try {
    return await handleAuthRequest(await getAuth(), request);
  } catch (error) {
    console.error(
      "Authentication service error:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { code: "SERVICE_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export const GET = handle;
export const POST = handle;
