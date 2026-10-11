import { isLoopback, readMailConfig } from "./mail-config";

export interface AuthConfig {
  secret: string;
  baseURL: string;
}

export function readAuthConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Set BETTER_AUTH_SECRET with npm run auth:setup.");
  const url = new URL(env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("BETTER_AUTH_URL must be an origin.");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid BETTER_AUTH_URL protocol.");
  const mail = readMailConfig(env);
  if (!isLoopback(url.hostname) && url.protocol !== "https:")
    throw new Error("Public BETTER_AUTH_URL requires HTTPS.");
  // File mail stays available locally, never as a fallback for public email.
  if (!isLoopback(url.hostname) && mail.driver === "file")
    throw new Error(
      "The demo mailbox requires a loopback BETTER_AUTH_URL. Configure real email before public hosting.",
    );
  return { secret, baseURL: url.origin };
}
