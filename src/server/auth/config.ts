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
  // The file mailbox is only for a local demo. Public hosting needs a mail provider.
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error(
      "The demo mailbox requires a loopback BETTER_AUTH_URL. Configure real email before public hosting.",
    );
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid BETTER_AUTH_URL protocol.");
  return { secret, baseURL: url.origin };
}
