import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DeliveryError } from "../../domain/delivery";
import { isUuid } from "../catalog/repository";
export interface DownloadGrant {
  user: string;
  subject: string;
  file: string;
  purpose: "purchase" | "document" | "free";
  exp: number;
}
export function signDownload(
  grant: Omit<DownloadGrant, "exp">,
  secret: string,
  now = Date.now(),
) {
  if (secret.length < 32)
    throw new Error("A download signing secret is required");
  const payload = Buffer.from(
    JSON.stringify({ ...grant, exp: Math.floor(now / 1000) + 300 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`beatstore-download-v1:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyDownload(
  token: string,
  secret: string,
  userId: string,
  now = Date.now(),
): DownloadGrant {
  const fail = () =>
    new DeliveryError(
      404,
      "Ссылка недействительна или истекла. Получи новую ссылку на сайте.",
    );
  if (
    secret.length < 32 ||
    token.length > 2048 ||
    !/^[\w-]+\.[\w-]+$/.test(token)
  )
    throw fail();
  const [payload, mac] = token.split(".");
  const expected = createHmac("sha256", secret)
    .update(`beatstore-download-v1:${payload}`)
    .digest();
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw fail();
  let v: DownloadGrant;
  try {
    v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw fail();
  }
  if (
    !v ||
    v.user !== userId ||
    !isUuid(v.user) ||
    !isUuid(v.subject) ||
    !isUuid(v.file) ||
    !["purchase", "document", "free"].includes(v.purpose) ||
    !Number.isSafeInteger(v.exp) ||
    v.exp <= Math.floor(now / 1000) ||
    v.exp > Math.floor(now / 1000) + 300
  )
    throw fail();
  return v;
}
