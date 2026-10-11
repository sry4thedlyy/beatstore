import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { YandexStorage } from "./yandex";

export async function checkStorage(
  storage: YandexStorage,
  anonymous = (url: string) =>
    fetch(url, {
      headers: { Range: "bytes=0-15" },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    }),
) {
  const operation = randomUUID(),
    ref = storage.reference("uploads", `${operation}.txt`);
  const bytes = randomBytes(64),
    checksum = createHash("sha256").update(bytes).digest("hex");
  let failed = false,
    error: unknown;
  try {
    await storage.putBytes(
      ref,
      bytes,
      "application/octet-stream",
      checksum,
      operation,
    );
    const info = await storage.head(ref);
    const stream = await storage.open(
      { ...ref, size_bytes: String(bytes.length), checksum },
      info,
      { start: 0, end: 15 },
    );
    const sample = Buffer.from(await new Response(stream).arrayBuffer());
    if (!sample.equals(bytes.subarray(0, 16)))
      throw new Error("Storage range check failed.");
    const response = await anonymous(storage.objectUrl(ref));
    await response.body?.cancel();
    if (![403, 404].includes(response.status))
      throw new Error(
        "Anonymous access was not denied. Check private bucket settings.",
      );
  } catch (e) {
    failed = true;
    error = e;
  }
  if (!(await storage.removeOwned(ref, operation)))
    throw new Error(
      "Storage check could not remove its temporary object. Retry after restoring access.",
    );
  if (failed) throw error;
  return { upload: true, download: true, range: true, anonymousDenied: true };
}
